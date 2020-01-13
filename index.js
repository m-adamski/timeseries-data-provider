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
            let requestTargets = request.payload["targets"];
            let requestRange = request.payload["range"];
            let requestMaxDataPoints = request.payload["maxDataPoints"];

            // Generate collection of promises
            let promiseCollection = requestTargets.map(targetItem => {
                let currentProxy = findProxy(targetItem["target"]);

                // Check if proxy configuration exist and is active
                if (currentProxy !== null && currentProxy.active === true) {
                    let targetQuery = `SELECT "value", "time" FROMM "${targetItem["target"]}" WHERE time >= '${requestRange["from"]}' AND time <= '${requestRange["to"]}' LIMIT ${requestMaxDataPoints}`;

                    return influxClient.query(targetQuery);
                }
            });

            return Promise.all(promiseCollection).then(resultCollection => {
                let responseData = [];

                resultCollection.forEach(result => {
                    let currentProxyData = result.groups().map(resultItem => {
                        let itemName = resultItem["name"];
                        let itemRowCollection = resultItem["rows"];

                        let dataPointCollection = itemRowCollection.map(item => {
                            return [item["value"], moment(item["time"]).format("x")];
                        });

                        return {
                            target: itemName,
                            datapoints: dataPointCollection
                        };
                    });

                    responseData.push(currentProxyData);
                });

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
            console.log(request.payload, request.query);
            return h.response([]).type("application/json");
        }
    });

    httpServer.route({
        method: ["GET", "POST"],
        path: "/tag-keys",
        handler: (request, h) => {
            console.log(request.payload, request.query);
            return h.response([]).type("application/json");
        }
    });

    httpServer.route({
        method: ["GET", "POST"],
        path: "/tag-values",
        handler: (request, h) => {
            console.log(request.payload, request.query);
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
                        });
                    })
                )
            }, interval * 1000);
        }
    }).catch(error => {
        logMessage(`An error occurred while trying to run HTTP Server: ${error}`, "ERROR");
    });
}).catch(error => {
    logMessage(`An error occurred while trying to establish connection to database: ${error}`, "ERROR");
});
