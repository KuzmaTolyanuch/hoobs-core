/**************************************************************************************************
 * hoobs-core / homebridge                                                                        *
 * Copyright (C) 2020 Homebridge                                                                  *
 * Copyright (C) 2020 HOOBS                                                                       *
 *                                                                                                *
 * This program is free software: you can redistribute it and/or modify                           *
 * it under the terms of the GNU General Public License as published by                           *
 * the Free Software Foundation, either version 3 of the License, or                              *
 * (at your option) any later version.                                                            *
 *                                                                                                *
 * This program is distributed in the hope that it will be useful,                                *
 * but WITHOUT ANY WARRANTY; without even the implied warranty of                                 *
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the                                  *
 * GNU General Public License for more details.                                                   *
 *                                                                                                *
 * You should have received a copy of the GNU General Public License                              *
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.                          *
 **************************************************************************************************/

const API = require("./api");
const User = require("./user");
const Crypto = require("crypto");
const Plugin = require("./plugin");
const Manager = require("./manager");
const Platform = require("./platform");

const { once } = require("hap-nodejs/dist/lib/util/once");
const { Logger, internal } = require("./logger");
const { existsSync, readFileSync, writeFileSync } = require("fs-extra");
const { uuid, Bridge, Accessory, Service, Characteristic, AccessoryLoader, CharacteristicEventTypes } = require("hap-nodejs");

const persist = require("node-persist").create();

module.exports = class Server {
    constructor(opts) {
        opts = opts || {};

        persist.initSync({ dir: User.cachedAccessoryPath() });

        this.api = new API();

        this.api.on("registerPlatformAccessories", (accessories) => {
            this.handleRegisterPlatformAccessories(accessories);
        });

        this.api.on("updatePlatformAccessories", (accessories) => {
            this.handleUpdatePlatformAccessories(accessories);
        });

        this.api.on("unregisterPlatformAccessories", (accessories) => {
            this.handleUnregisterPlatformAccessories(accessories);
        });

        this.api.on("publishExternalAccessories", (accessories) => {
            this.handlePublishExternalAccessories(accessories);
        });

        this.config = opts.config || this.loadConfig();
        this.plugins = this.loadPlugins();
        this.cachedPlatformAccessories = this.loadCachedPlatformAccessories();
        this.bridge = this.createBridge();
        this.removeOrphans = opts.removeOrphans || false;

        this.externalPorts = this.config.ports;
        this.nextExternalPort = undefined;

        this.activeDynamicPlugins = {};
        this.configurablePlatformPlugins = {};
        this.publishedAccessories = {};
        this.setupManager = new Manager();

        this.setupManager.on("newConfig", () => {
            this.handleNewConfig()
        });

        this.setupManager.on("requestCurrentConfig", (callback) => {
            callback(this.config);
        });
    }

    run() {
        this.asyncCalls = 0;
        this.asyncWait = true;

        if (this.config.platforms) {
            this.loadPlatforms();
        }

        if (this.config.accessories) {
            this.loadAccessories();
        }

        this.loadDynamicPlatforms();
        this.configCachedPlatformAccessories();
        this.setupManager.configurablePlatformPlugins = this.configurablePlatformPlugins;
        this.bridge.addService(this.setupManager.service);

        this.asyncWait = false;

        if (this.asyncCalls == 0) {
            this.publish();
        }

        this.api.emit("didFinishLaunching");

        process.send({ event: "api_launched" });
    }

    publish() {
        const bridgeConfig = this.config.bridge || {};
        const info = this.bridge.getService(Service.AccessoryInformation);

        info.setCharacteristic(Characteristic.Manufacturer, bridgeConfig.manufacturer || "HOOBS");
        info.setCharacteristic(Characteristic.Model, bridgeConfig.model || "HOOBS");
        info.setCharacteristic(Characteristic.SerialNumber, bridgeConfig.username);
        info.setCharacteristic(Characteristic.FirmwareRevision, require("../package.json").version);

        this.bridge.on("listening", (port) => {
            internal.info(`Bridge is running on port ${port}.`);
        });

        const publishInfo = {
            username: bridgeConfig.username || "CC:22:3D:E3:CE:30",
            port: bridgeConfig.port || 0,
            pincode: bridgeConfig.pin || "031-45-154",
            category: Accessory.Categories.BRIDGE,
            mdns: this.config.mdns
        };

        if (bridgeConfig.setupID && bridgeConfig.setupID.length === 4) {
            publishInfo["setupID"] = bridgeConfig.setupID;
        }

        this.bridge.publish(publishInfo, true);
        this.printSetupInfo();

        process.send({ event: "running" });
    }

    loadPlugins() {
        const plugins = {};
        const activePlugins = this.computeActivePluginList();

        let foundOnePlugin = false;

        Plugin.installed().forEach((plugin) => {
            if (activePlugins !== undefined && activePlugins[plugin.name()] !== true) {
                return;
            }

            try {
                plugin.load();
            } catch (err) {
                internal.error(`Error loading plugin "${plugin.name()}".`);
                internal.error(err.stack);

                plugin.loadError = err;
            }

            if (!plugin.loadError) {
                plugins[plugin.name()] = plugin;

                internal.info(`Loaded plugin "${plugin.name()}".`);

                plugin.initializer(this.api);

                foundOnePlugin = true;
            }
        });

        if (!foundOnePlugin) {
            internal.warn("No plugins found.");
        }

        return plugins;
    }

    loadConfig() {
        const configPath = User.configPath();

        if (!existsSync(configPath)) {
            internal.warn(`config.json "${configPath}" not found.`);

            return {
                bridge: {
                    name: "HOOBS",
                    username: "CC:22:3D:E3:CE:30",
                    pin: "031-45-154"
                }
            };
        }

        let config = {};

        try {
            config = JSON.parse(readFileSync(configPath));
        } catch (err) {
            internal.error("There was a problem reading your config.json file.");

            return {
                bridge: {
                    name: "HOOBS",
                    username: "CC:22:3D:E3:CE:30",
                    pin: "031-45-154"
                }
            };
        }

        if (config.ports !== undefined) {
            if (config.ports.start > config.ports.end) {
                internal.error("Invalid port pool configuration. End should be greater than or equal to start.");

                config.ports = undefined;
            }
        }

        if (!/^([0-9A-F]{2}:){5}([0-9A-F]{2})$/.test(config.bridge.username)) {
            internal.error(`Not a valid username: "${config.bridge.username}".`);

            config.bridge.username = "CC:22:3D:E3:CE:30";
        }

        return config;
    }

    loadCachedPlatformAccessories() {
        const cachedAccessories = persist.getItem("cachedAccessories");
        const platformAccessories = [];

        if (cachedAccessories) {
            for (let index in cachedAccessories) {
                platformAccessories.push(Platform.deserialize(cachedAccessories[index]));
            }
        }

        return platformAccessories;
    }

    computeActivePluginList() {
        if (this.config.plugins === undefined) {
            return undefined;
        }

        const activePlugins = {};

        for (let i = 0; i < this.config.plugins.length; i++) {
            activePlugins[this.config.plugins[i]] = true;
        }

        return activePlugins;
    }

    createBridge() {
        return new Bridge((this.config.bridge || {}).name || "HOOBS", uuid.generate("HomeBridge"));
    }

    loadAccessories() {
        for (let i = 0; i < this.config.accessories.length; i++) {
            const init = this.api.accessory(this.config.accessories[i]["accessory"]);

            if (!init) {
                internal.warn(`Your config.json is requesting the accessory "${this.config.accessories[i]["accessory"]}" which has not been published by any installed plugins.`);
            } else {
                const logger = Logger.withPrefix(this.config.accessories[i]["name"]);
                const instance = new init(logger, this.config.accessories[i], this.api);
                const accessory = this.createAccessory(instance, this.config.accessories[i]["name"], this.config.accessories[i]["accessory"], this.config.accessories[i].uuid_base);

                if (accessory) {
                    this.bridge.addBridgedAccessory(accessory);
                }
            }
        }
    }

    loadPlatforms() {
        for (let i = 0; i < this.config.platforms.length; i++) {
            const init = this.api.platform(this.config.platforms[i].platform);

            if (!init) {
                internal.warn(`Your config.json is requesting the platform "${this.config.platforms[i].platform}" which has not been published by any installed plugins.`);
            } else {
                const logger = Logger.withPrefix(this.config.platforms[i].name || this.config.platforms[i].platform);
                const instance = new init(logger, this.config.platforms[i], this.api);

                if (instance.configureAccessory == undefined) {
                    this.loadPlatformAccessories(instance, logger, this.config.platforms[i].platform);
                } else {
                    this.activeDynamicPlugins[this.config.platforms[i].platform] = instance;
                }

                if (instance.configurationRequestHandler != undefined) {
                    this.configurablePlatformPlugins[this.config.platforms[i].platform] = instance;
                }
            }
        }
    }

    loadDynamicPlatforms() {
        for (let dynamicPluginName in this.api.dynamicPlatforms) {
            if (!this.activeDynamicPlugins[dynamicPluginName] && !this.activeDynamicPlugins[dynamicPluginName.split(".")[1]]) {
                process.send({ event: "info_log", data: `Load ${dynamicPluginName}` });

                const init = this.api.dynamicPlatforms[dynamicPluginName];
                const logger = Logger.withPrefix(dynamicPluginName);
                const instance = new init(logger, null, this.api);

                this.activeDynamicPlugins[dynamicPluginName] = instance;

                if (instance.configurationRequestHandler != undefined) {
                    this.configurablePlatformPlugins[dynamicPluginName] = instance;
                }
            }
        }
    }

    configCachedPlatformAccessories() {
        const verifiedAccessories = [];

        for (let index in this.cachedPlatformAccessories) {
            const accessory = this.cachedPlatformAccessories[index];

            if (!(accessory instanceof Platform)) {
                process.send({ event: "error_log", data: "Unexpected Accessory" });

                continue;
            }

            let instance = this.activeDynamicPlugins[accessory.associatedPlugin + "." + accessory.associatedPlatform];

            if (!instance) {
                instance = this.activeDynamicPlugins[accessory.associatedPlatform];
            }

            if (instance) {
                instance.configureAccessory(accessory);
            } else {
                process.send({ event: "error_log", data: `Failed to find plugin to handle accessory ${accessory.displayName}` });

                if (this.removeOrphans) {
                    process.send({ event: "info_log", data: `Removing orphaned accessory ${accessory.displayName}` });

                    continue;
                }
            }

            verifiedAccessories.push(accessory);

            this.bridge.addBridgedAccessory(accessory.associated);
        }

        this.cachedPlatformAccessories = verifiedAccessories;
    }

    loadPlatformAccessories(instance, internal, platformType) {
        this.asyncCalls++;

        instance.accessories(once((foundAccessories) => {
            this.asyncCalls--;

            for (let i = 0; i < foundAccessories.length; i++) {
                const accessoryInstance = foundAccessories[i];

                internal(`Initializing platform accessory "${accessoryInstance.name}"...`);

                this.bridge.addBridgedAccessory(this.createAccessory(accessoryInstance, accessoryInstance.name, platformType, accessoryInstance.uuid_base));
            }

            if (this.asyncCalls === 0 && !this.asyncWait) {
                this.publish();
            }
        }));
    }

    createAccessory(accessoryInstance, displayName, accessoryType, uuidBase) {
        const services = (accessoryInstance.getServices() || []).filter(service => !!service);
        const controllers = (accessoryInstance.getControllers && accessoryInstance.getControllers() || []).filter(controller => !!controller);

        if (services.length === 0 && controllers.length === 0) {
            return undefined;
        }

        if (!(services[0] instanceof Service)) {
            return AccessoryLoader.parseAccessoryJSON({
                displayName,
                services
            });
        } else {
            const accessory = new Accessory(displayName, uuid.generate(accessoryType + ":" + (uuidBase || displayName)));

            accessory.on("service-characteristic-change", (data) => {
                if (
                    data.newValue !== data.oldValue
                 && data.characteristic.displayName !== "Last Updated"
                 && data.characteristic.displayName !== "Serial Number"
                 && data.characteristic.displayName !== "Manufacturer"
                 && data.characteristic.displayName !== "Identify"
                 && data.characteristic.displayName !== "Model"
                ) {
                    process.send({ event: "accessory_change" });
                }
            });

            if (accessoryInstance.identify) {
                accessory.on("identify", (_paired, callback) => {
                    accessoryInstance.identify(() => {});

                    callback();
                });
            }

            const informationService = accessory.getService(Service.AccessoryInformation);

            for (let i = 0; i < services.length; i++) {
                if (services[i] instanceof Service.AccessoryInformation) {
                    services[i].setCharacteristic(Characteristic.Name, displayName);
                    services[i].getCharacteristic(Characteristic.Identify).removeAllListeners(CharacteristicEventTypes.SET);
                    informationService.replaceCharacteristicsFromService(services[i]);
                } else {
                    accessory.addService(services[i]);
                }
            }

            for (let i = 0; i < controllers.length; i++) {
                accessory.configureController(controllers[i]);
            }

            return accessory;
        }
    }

    handleRegisterPlatformAccessories(accessories) {
        const hapAccessories = [];

        for (let index in accessories) {
            const accessory = accessories[index];

            hapAccessories.push(accessory.associated);

            this.cachedPlatformAccessories.push(accessory);
        }

        this.bridge.addBridgedAccessories(hapAccessories);
        this.updateCachedAccessories();
    }

    handleUpdatePlatformAccessories() {
        this.updateCachedAccessories();
    }

    handleUnregisterPlatformAccessories(accessories) {
        const hapAccessories = [];

        for (let index in accessories) {
            const accessory = accessories[index];

            if (accessory.associated) {
                hapAccessories.push(accessory.associated);
            }

            for (let targetIndex in this.cachedPlatformAccessories) {
                if (this.cachedPlatformAccessories[targetIndex].UUID === accessory.UUID) {
                    this.cachedPlatformAccessories.splice(targetIndex, 1);

                    break;
                }
            }
        }

        this.bridge.removeBridgedAccessories(hapAccessories);
        this.updateCachedAccessories();
    }

    handlePublishExternalAccessories(accessories) {
        for (let index in accessories) {
            const accessory = accessories[index];

            let accessoryPort = 0;

            if (this.externalPorts) {
                if (this.nextExternalPort > this.externalPorts.end) {
                    internal.info("External port pool ran out of ports. Fallback to random assign.");

                    accessoryPort = 0;
                } else {
                    if (this.nextExternalPort !== undefined) {
                        accessoryPort = this.nextExternalPort;

                        this.nextExternalPort += 1;
                    } else {
                        accessoryPort = this.externalPorts.start;

                        this.nextExternalPort = this.externalPorts.start + 1;
                    }
                }
            }

            const hapAccessory = accessory.associated;
            const advertiseAddress = this.generateAddress(accessory.UUID);

            if (this.publishedAccessories[advertiseAddress]) {
                internal.warn(`Accessory ${accessory.displayName}experienced an address collision.`);
            } else {
                this.publishedAccessories[advertiseAddress] = accessory;

                ((name) => {
                    hapAccessory.on("listening", (port) => {
                        internal.info(`${name} is running on port ${port}.`);
                    });
                })(accessory.displayName);

                hapAccessory.publish({
                    username: advertiseAddress,
                    pincode: (this.config.bridge || {}).pin || "031-45-154",
                    category: accessory.category,
                    port: accessoryPort,
                    mdns: this.config.mdns
                }, true);
            }
        }
    }

    updateCachedAccessories() {
        const serializedAccessories = [];

        for (let index in this.cachedPlatformAccessories) {
            serializedAccessories.push(Platform.serialize(this.cachedPlatformAccessories[index]));
        }

        persist.setItemSync("cachedAccessories", serializedAccessories);
    }

    generateAddress(data) {
        const sha1sum = Crypto.createHash("sha1");

        sha1sum.update(data);

        let s = sha1sum.digest("hex");
        let i = -1;

        return "xx:xx:xx:xx:xx:xx".replace(/[x]/g, function () {
            i += 1;

            return s[i];
        }).toUpperCase();
    }

    teardown() {
        this.updateCachedAccessories();
        this.bridge.unpublish();

        Object.keys(this.publishedAccessories).forEach((advertiseAddress) => {
            this.publishedAccessories[advertiseAddress].associated.unpublish();
        });
    }

    handleNewConfig(type, name, replace, config) {
        if (type === "accessory") {
            if (!this.config.accessories) {
                this.config.accessories = [];
            }

            if (!replace) {
                this.config.accessories.push(config);
            } else {
                let targetName;

                if (name.indexOf(".") !== -1) {
                    targetName = name.split(".")[1];
                }

                let found = false;

                for (let index in this.config.accessories) {
                    if (this.config.accessories[index].accessory === name) {
                        this.config.accessories[index] = config;

                        found = true;

                        break;
                    }

                    if (targetName && (this.config.accessories[index].accessory === targetName)) {
                        this.config.accessories[index] = config;

                        found = true;

                        break;
                    }
                }

                if (!found) {
                    this.config.accessories.push(config);
                }
            }
        } else if (type === "platform") {
            if (!this.config.platforms) {
                this.config.platforms = [];
            }

            if (!replace) {
                this.config.platforms.push(config);
            } else {
                let targetName;

                if (name.indexOf(".") !== -1) {
                    targetName = name.split(".")[1];
                }

                let found = false;

                for (let index in this.config.platforms) {
                    if (this.config.platforms[index].platform === name) {
                        this.config.platforms[index] = config;

                        found = true;

                        break;
                    }

                    if (targetName && (this.config.platforms[index].platform === targetName)) {
                        this.config.platforms[index] = config;

                        found = true;

                        break;
                    }
                }

                if (!found) {
                    this.config.platforms.push(config);
                }
            }
        }

        writeFileSync(User.configPath(), JSON.stringify(this.config, null, 4), "utf8");
    }

    printSetupInfo() {
        process.send({ event: "setup_uri", data: this.bridge.setupURI() });
    }
}
