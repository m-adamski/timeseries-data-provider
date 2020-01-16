const axios = require("axios");
const hapi = require("@hapi/hapi");
const hapiAuth = require("@hapi/basic");
const influx = require("influx");
const moment = require("moment");

// Import config
const config = require("./config");

// Define function to display specified message
const logMessage = (message, type, series) => {
    let messageDate = moment().format("YYYY-MM-DD HH:mm:ss");
    let messageType = type || "";
    let messageSeries = series || "";

    console.log(`[${messageDate}][${messageType}][${messageSeries}] ${message}`);
};

// Authenticate
const httpServerAuth = async (request, username, password, h) => {
    if (username === config.server.authConfig.username && password === config.server.authConfig.password) {
        return {credentials: {name: "Authenticated User"}, isValid: true}
    }

    return {credentials: null, isValid: false}
};

const findProxy = (proxyName) => {
    return config.proxy.find(currentProxy => {
        return currentProxy.name === proxyName;
    });
};

// Create instance of InfluxDB Client
const initInfluxDBClient = async () => {
    const influxClient = new influx.InfluxDB(config.influxDB);

    // Create database if not exist
    influxClient.getDatabaseNames().then(names => {
        if (!names.includes(config.influxDB.database)) {
            return influxClient.createDatabase(config.influxDB.database);
        }
    }).catch(error => {
        throw error;
    });

    return influxClient;
};

// Create instance of HTTP Server
const initServer = async (influxClient) => {
    const httpServer = hapi.server(config.server.hostConfig);

    // Register Basic Auth Plugin
    if (config.server.authConfig.active === true) {
        await httpServer.register(hapiAuth);

        // Set Auth Strategy
        httpServer.auth.strategy("simple", "basic", {validate: httpServerAuth});
        httpServer.auth.default("simple");
    }

    // Define routes
    httpServer.route({
        method: ["GET", "POST"],
        path: "/",
        handler: (request, h) => {
            return h.response({"message": "Hello! API is working!"}).type("application/json");
        }
    });

    httpServer.route({
        method: ["GET", "POST"],
        path: "/search",
        handler: (request, h) => {
            let responseCollection = config.proxy.filter(currentProxy => {
                return currentProxy.active;
            }).map(currentProxy => {
                return currentProxy.name;
            });

            return h.response(responseCollection).type("application/json");
        }
    });

    httpServer.route({
        method: ["GET", "POST"],
        path: "/query",
        handler: (request, h) => {
            let requestTargets = request.payload["targets"];
            let requestRange = request.payload["range"];
            let requestMaxDataPoints = request.payload["maxDataPoints"];

            let targetTypes = [];

            // Generate collection of promises
            let promiseCollection = requestTargets.map(targetItem => {
                let targetName = targetItem["target"];
                let targetType = targetItem["type"];
                let currentProxy = findProxy(targetName);

                // Check if proxy configuration exist and is active
                if (currentProxy !== null && currentProxy.active === true) {
                    targetTypes[targetName] = targetType;

                    let targetQuery = `SELECT "value", "time" FROM "${targetItem["target"]}" WHERE time >= '${requestRange["from"]}' AND time <= '${requestRange["to"]}' LIMIT ${requestMaxDataPoints}`;

                    return influxClient.query(targetQuery);
                }
            });

            return Promise.all(promiseCollection).then(resultCollection => {
                let responseData = [];
                let responseTableData = [];

                resultCollection.forEach(result => {
                    result.groups().forEach(resultItem => {
                        let itemName = resultItem["name"];
                        let itemRowCollection = resultItem["rows"];

                        let dataPointCollection = itemRowCollection.map(item => {
                            return [item["value"], Number.parseInt(moment(item["time"]).format("x"))];
                        });

                        if (targetTypes[itemName] === "timeseries") {
                            responseData.push({
                                target: itemName,
                                datapoints: dataPointCollection
                            });
                        } else if (targetTypes[itemName] === "table") {
                            responseTableData = dataPointCollection.map(item => {
                                item.unshift(itemName);

                                return item;
                            });
                        }
                    });
                });

                if (responseTableData.length > 0) {
                    responseData.push({
                        "columns": [
                            {"text": "Target", "type": "string"},
                            {"text": "Value", "type": "number"},
                            {"text": "Time", "type": "time"}
                        ],
                        "rows": responseTableData,
                        "type": "table"
                    });
                }

                return h.response(responseData).type("application/json");
            }).catch(error => {
                logMessage(`An error occurred while trying to process query: ${error}`, "ERROR");
            });
        }
    });

    httpServer.route({
        method: ["GET", "POST"],
        path: "/annotations",
        handler: (request, h) => {
            return h.response([]).type("application/json");
        }
    });

    httpServer.route({
        method: ["GET", "POST"],
        path: "/tag-keys",
        handler: (request, h) => {
            return h.response([]).type("application/json");
        }
    });

    httpServer.route({
        method: ["GET", "POST"],
        path: "/tag-values",
        handler: (request, h) => {
            return h.response([]).type("application/json");
        }
    });

    // Start HTTP Server
    await httpServer.start();

    return httpServer;
};

// Start services
initInfluxDBClient().then(influxClient => {
    logMessage("A database connection has been established", "INFO");

    // Add schema to Influx Client
    config.proxy.forEach(proxyItem => {
        if (proxyItem.active && proxyItem.interval > 0) {
            influxClient.addSchema({
                measurement: proxyItem.name,
                fields: {
                    value: influx.FieldType.FLOAT
                },
                tags: [proxyItem.name]
            });
        }
    });

    initServer(influxClient).then(httpServer => {
        logMessage(`HTTP Server is running and listening at ${httpServer.info.uri}`, "INFO");

        // Add X-Custom-Request-Name header to request configuration
        config.proxy.forEach(proxyItem => {
            proxyItem.config.headers = {...proxyItem.config.headers, ...{"X-Custom-Request-Name": proxyItem.name}};
        });

        // Prepare collection to run
        let proxyCollection = config.proxy.filter(proxyItem => {
            return proxyItem.active && proxyItem.interval > 0;
        }).map(proxyItem => {
            return {
                proxy: proxyItem,
                lastRun: null,
                lastRemove: null
            }
        });

        setInterval(() => {
            let intervalDate = moment();

            proxyCollection.forEach(proxyItem => {
                let proxyName = proxyItem.proxy.name;
                let proxyInterval = proxyItem.proxy.interval;
                let proxyRemoveInterval = proxyItem.proxy.autoRemove.interval;
                let proxyRemoveAge = proxyItem.proxy.autoRemove.age;
                let proxyRequestConfig = proxyItem.proxy.config;
                let lastRun = proxyItem.lastRun;
                let lastRemove = proxyItem.lastRemove;

                // Check if current proxy need to be process
                if (!lastRun || (lastRun && moment(intervalDate).isAfter(moment(lastRun).add(proxyInterval, "seconds")))) {
                    proxyItem.lastRun = intervalDate;

                    // Send request
                    axios(proxyRequestConfig).then(response => {
                        let proxyName = response.config.headers["X-Custom-Request-Name"];
                        let responseValue = response.data;

                        if (responseValue !== null && responseValue !== undefined) {

                            logMessage("Processing data..", "INFO", proxyName);

                            influxClient.writePoints([
                                {
                                    measurement: proxyName,
                                    fields: {
                                        value: responseValue
                                    }
                                }
                            ]).then(() => {
                                logMessage("The data has been saved successfully", "INFO", proxyName);
                            }).catch(error => {
                                logMessage("An error occurred while trying to save the data", "ERROR", proxyName);
                            })
                        } else {
                            logMessage("An error occurred while processing the server response", "ERROR", proxyName);
                        }
                    });
                }

                // Check if data need to be auto remove
                if (!lastRemove || (lastRemove && proxyRemoveInterval && moment(intervalDate).isAfter(moment(lastRemove).add(proxyRemoveInterval, "seconds")))) {
                    proxyItem.lastRemove = intervalDate;

                    let queryDate = moment().subtract(proxyRemoveAge, "seconds").utc().format();
                    let deleteQuery = `DELETE FROM "${proxyName}" WHERE time < '${queryDate}'`;

                    logMessage(`Cleaning entries older than ${queryDate}`, "INFO", proxyName);

                    influxClient.query(deleteQuery).then(() => {
                        logMessage("Old entries have been successfully deleted", "INFO", proxyName);
                    }).catch(error => {
                        logMessage("An error occurred while clearing old entries", "ERROR", proxyName);
                    });
                }
            });
        }, 1000);
    }).catch(error => {
        logMessage(`An error occurred while trying to run HTTP Server: ${error}`, "ERROR");
    });
}).catch(error => {
    logMessage(`An error occurred while trying to establish connection to database: ${error}`, "ERROR");
});
