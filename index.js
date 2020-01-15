const axios = require("axios");
const hapi = require("@hapi/hapi");
const hapiAuth = require("@hapi/basic");
const influx = require("influx");
const moment = require("moment");

// Import config
const config = require("./config");

// Define function to display specified message
const logMessage = (message, type) => {
    console.log(`[${moment().format("YYYY-MM-DD HH:mm:ss")}][${type}] ${message}`);
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
            console.log("search", request.payload);

            // Filter for active proxy configurations and return names
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
            console.log("query", request.payload);

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

                    let targetQuery = `SELECT "value", "time" FROM "${targetItem["target"]}" WHERE time >= '${requestRange["from"]}' AND time <= '${requestRange["to"]}' ORDER BY time DESC LIMIT ${requestMaxDataPoints}`;

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
            console.log("annotations", request.payload);
            return h.response([]).type("application/json");
        }
    });

    httpServer.route({
        method: ["GET", "POST"],
        path: "/tag-keys",
        handler: (request, h) => {
            console.log("tag-keys", request.payload);
            return h.response([]).type("application/json");
        }
    });

    httpServer.route({
        method: ["GET", "POST"],
        path: "/tag-values",
        handler: (request, h) => {
            console.log("tag-values", request.payload);
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

    initServer(influxClient).then(httpServer => {
        logMessage(`HTTP Server is running and listening at ${httpServer.info.uri}`, "INFO");

        // Define requests collection grouped by interval
        let requestCollection = {};

        // Move every provided request configuration
        config.proxy.forEach(proxy => {
            if (proxy.name !== undefined && proxy.interval !== undefined && proxy.config !== undefined) {
                proxy.config.headers = {...proxy.config.headers, ...{"X-Custom-Request-Name": proxy.name}};

                // Init collection
                if (!Array.isArray(requestCollection[proxy.interval])) {
                    requestCollection[proxy.interval] = [];
                }

                // Push generated request into collection
                requestCollection[proxy.interval].push(axios(proxy.config));

                // Add schema to influx Client
                influxClient.addSchema({
                    measurement: proxy.name,
                    fields: {
                        value: influx.FieldType.FLOAT
                    },
                    tags: [proxy.name]
                });
            }
        });

        // Move every generated request
        for (const [interval, collection] of Object.entries(requestCollection)) {
            setInterval(() => {
                axios.all(collection).then(
                    axios.spread((...args) => {
                        args.forEach(currentResponse => {
                            let proxyName = currentResponse.config.headers["X-Custom-Request-Name"];
                            let responseData = currentResponse.data;

                            if (responseData !== null && responseData["value"] !== null) {

                                logMessage(`Data processing for the '${proxyName}' request`, "INFO");

                                influxClient.writePoints([
                                    {
                                        measurement: proxyName,
                                        fields: responseData
                                    }
                                ]).then(() => {
                                    logMessage("The data has been saved successfully", "INFO");
                                }).catch(error => {
                                    logMessage(`An error occurred while trying to save the data: ${error}`, "ERROR");
                                })
                            } else if (responseData["error"] !== null) {
                                logMessage(`An error occurred while processing the server response: ${responseData["error"]}`, "ERROR");
                            } else {
                                logMessage("An error occurred while processing the server response", "ERROR");
                            }
                        });
                    })
                )
            }, interval * 1000);
        }

        setInterval(() => {
            config.proxy.forEach(currentProxy => {
                if (currentProxy["autoRemove"]["active"] === true) {
                    let entryAge = currentProxy["autoRemove"]["age"];

                    if (Number.isInteger(entryAge) && entryAge > 0) {
                        let queryDate = moment().subtract(entryAge, "hours").utc().format();
                        let deleteQuery = `DELETE FROM "${currentProxy.name}" WHERE time < '${queryDate}'`;

                        logMessage(`Automatic data cleaning: ${currentProxy.name}`, "INFO");

                        influxClient.query(deleteQuery).then(() => {
                            logMessage(`The data has been cleared according to the configuration: ${currentProxy.name}`, "INFO");
                        }).catch(error => {
                            logMessage(`An error occurred during automatic data cleaning: ${currentProxy.name}: ${error}`, "ERROR");
                        });
                    }
                }
            });
        }, 3600000);
    }).catch(error => {
        logMessage(`An error occurred while trying to run HTTP Server: ${error}`, "ERROR");
    });
}).catch(error => {
    logMessage(`An error occurred while trying to establish connection to database: ${error}`, "ERROR");
});
