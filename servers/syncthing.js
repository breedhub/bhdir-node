/**
 * Syncthing server
 * @module servers/syncthing
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const uuid = require('uuid');
const convert = require('xml-js');
const EventEmitter = require('events');
const WError = require('verror').WError;

/**
 * Server class
 */
class Syncthing extends EventEmitter {
    /**
     * Create the service
     * @param {App} app                             Application
     * @param {object} config                       Configuration
     * @param {Logger} logger                       Logger service
     * @param {Runner} runner                       Runner service
     * @param {Filer} filer                         Filer service
     * @param {Util} util                           Util service
     */
    constructor(app, config, logger, runner, filer, util) {
        super();

        this.syncthing = null;
        this.node = null;
        this.roles = [];
        this.folders = new Map();

        this._name = null;
        this._app = app;
        this._config = config;
        this._logger = logger;
        this._runner = runner;
        this._filer = filer;
        this._util = util;
    }

    /**
     * Service name is 'servers.syncthing'
     * @type {string}
     */
    static get provides() {
        return 'servers.syncthing';
    }

    /**
     * Dependencies as constructor arguments
     * @type {string[]}
     */
    static get requires() {
        return [ 'app', 'config', 'logger', 'runner', 'filer', 'util' ];
    }

    /**
     * Syncthing version
     * @type {string}
     */
    static get version() {
        return '0.14.26';
    }

    /**
     * Main address
     * @type {string}
     */
    static get mainAddress() {
        return '0.0.0.0';
    }

    /**
     * Main port
     * @type {string}
     */
    static get mainPort() {
        return '42000';
    }

    /**
     * API address
     * @type {string}
     */
    static get apiAddress() {
        return '127.0.0.1';
    }

    /**
     * API port
     * @type {string}
     */
    static get apiPort() {
        return '42001';
    }

    /**
     * Announce port
     * @type {string}
     */
    static get announcePort() {
        return '42002';
    }

    /**
     * Announce port
     * @type {string}
     */
    static get announceMCAddress() {
        return '[ff12::8384]:42002';
    }

    /**
     * Roles
     */
    static get roles() {
        return [ 'coordinator', 'relay' ];
    }

    /**
     * Get main bin path
     * @return {Promise}
     */
    static getMainBinary() {
        return Promise.resolve(path.join(__dirname, '..', 'dist', `syncthing-${this.version}`))
            .then(bin => {
                let platform, ver;
                if (os.platform() === 'freebsd') {
                    platform = 'freebsd';
                    ver = os.release().replace(/^([0-9]+).*$/, '$1');
                } else {
                    try {
                        let release = fs.readFileSync('/etc/debian_version', 'utf8');
                        platform = 'debian';
                        ver = release.trim().replace(/^([0-9]+).*$/, '$1');
                    } catch (error) {
                        return null;
                    }
                }
                return path.join(bin, platform + '-' + ver + '-' + os.arch());
            })
            .then(bin => {
                if (!bin)
                    return null;

                try {
                    fs.accessSync(path.join(bin, 'syncthing'), fs.constants.X_OK);
                } catch (error) {
                    return null;
                }

                return path.join(bin, 'syncthing');
            });
    }

    /**
     * Initialize the server
     * @param {string} name                     Config section name
     * @return {Promise}
     */
    init(name) {
        this._name = name;

        return Promise.resolve();
    }

    /**
     * Start the server
     * @param {string} name                     Config section name
     * @return {Promise}
     */
    start(name) {
        if (name !== this._name)
            return Promise.reject(new Error(`Server ${name} was not properly initialized`));

        return Array.from(this._app.get('modules')).reduce(
                (prev, [curName, curModule]) => {
                    return prev.then(() => {
                        if (!curModule.register)
                            return;

                        let result = curModule.register(name);
                        if (result === null || typeof result !== 'object' || typeof result.then !== 'function')
                            throw new Error(`Module '${curName}' register() did not return a Promise`);
                        return result;
                    });
                },
                Promise.resolve()
            )
            .then(() => {
                try {
                    fs.accessSync('/var/lib/bhdir/.config/node.json', fs.constants.F_OK);
                } catch (error) {
                    return;
                }

                return this._filer.lockRead('/var/lib/bhdir/.config/node.json')
                    .then(contents => {
                        this.node = JSON.parse(contents);
                        if (!this.node.device || !this.node.device.id || !this.node.device.name) {
                            this.node = null;
                            return;
                        }

                        if (!this.node.id)
                            return;

                        return this._directory.get(`.core:/home/nodes/by_id/${this.node.id}`)
                            .then(info => {
                                if (!info || !info.value)
                                    return;

                                this.roles = info.value.roles || [];
                            })
                            .then(() => {
                                return this._filer.lockRead('/var/lib/bhdir/.syncthing/config.xml')
                                    .then(contents => {
                                        let st = convert.xml2js(contents, { compact: true });
                                        for (let folder of Array.isArray(st.configuration.folder) ? st.configuration.folder : [ st.configuration.folder ])
                                            this.folders.set(folder._attributes.label, folder._attributes);
                                    });
                            });
                    })
            })
            .then(() => {
                this._logger.debug('syncthing', 'Starting the server');
                return this.startMainBinary();
            });
    }

    /**
     * Start main binary
     */
    startMainBinary() {
        if (this.syncthing || !this.node)
            return Promise.resolve();

        return this.constructor.getMainBinary()
            .then(syncthing => {
                if (!syncthing)
                    throw new Error('No syncthing found');

                return this._runner.spawn(
                    syncthing,
                    [
                        '-home=/var/lib/bhdir/.syncthing',
                        '-no-restart',
                    ],
                    {
                        env: {
                            "LANGUAGE": "C.UTF-8",
                            "LANG": "C.UTF-8",
                            "LC_ALL": "C.UTF-8",
                            "PATH": "/bin:/sbin:/usr/bin:/usr/sbin:/usr/local/bin:/usr/local/sbin",
                            "HOME": '/var/lib/bhdir/.syncthing',
                            "STNODEFAULTFOLDER": "1",
                            "STNOUPGRADE": "1",
                        }
                    }
                );
            })
            .then(sub => {
                this._logger.info('Syncthing main binary started');
                this.syncthing = sub;

                let logger = this._app.get('logger');
                logger.setLogStream('syncthing');

                sub.cmd.on('data', data => { logger.dump(data.toString().trim()); });
                sub.promise
                    .then(
                        result => {
                            this.syncthing = null;
                            this._logger.info(`Syncthing main binary terminated: ${result.code}`);
                        },
                        error => {
                            this.syncthing = null;
                            this._logger.error(`Syncthing main binary error: ${error.message}`);
                        }
                    );
            });
    }

    /**
     * Stop main binary
     */
    stopMainBinary() {
        if (!this.syncthing || !this.node)
            return Promise.resolve();

        this.syncthing.kill();
        return this.syncthing.promise;
    }

    /**
     * Create network
     * @param {string} name                     Name of the network
     * @return {Promise}
     */
    createNetwork(name) {
        let now = Math.round(Date.now() / 1000), deviceId;
        return this._filer.lockUpdate(
            '/var/lib/bhdir/.config/node.json',
            contents => {
                let json = JSON.parse(contents);
                json.id = '1';
                this.node = json;
                return Promise.resolve(JSON.stringify(json, undefined, 4) + '\n');
            }
        )
        .then(() => {
            return this._filer.lockUpdate(
                '/var/lib/bhdir/.syncthing/config.xml',
                contents => {
                    let st = convert.xml2js(contents, { compact: true });
                    let attributes = {
                        id: this._util.getRandomString(32, { lower: true, upper: true, digits: true, special: false }),
                        label: ".core",
                        path: "/var/lib/bhdir/.core/",
                        type: "readwrite",
                        rescanIntervalS: "60",
                        ignorePerms: "false",
                        autoNormalize: "true",
                    };
                    this.folders.set('.core', attributes);

                    st.configuration.folder = this._initFolder(attributes);

                    return Promise.resolve(convert.js2xml(st, { compact: true, spaces: 4 }) + '\n');
                }
            );
        })
        .then(() => {
            return this._directory.create('.core');
        })
        .then(() => {
            return this._directory.set(
                '.core:/home/created',
                null,
                now
            );
        })
        .then(() => {
            return this._directory.set(
                '.core:/home/name',
                null,
                name
            );
        })
        .then(() => {
            return this._directory.set(
                '.core:/home/last_id',
                null,
                '1'
            );
        })
        .then(() => {
            return this._directory.set(
                '.core:/home/nodes/by_id/1',
                null,
                {
                    created: now,
                    roles: [ 'coordinator' ],
                    devices: {
                        [this.node.device.id]: {
                            name: this.node.device.name,
                        }
                    },
                }
            );
        })
        .then(() => {
            return this._coordinator.startListening();
        });
    }

    /**
     * Join network
     * @param {string} address                      Coordinator address
     * @param {string} token                        Join token
     */
    joinNetwork(address, token) {
        if (!this.node || this.node.id)
            return Promise.resolve();

        let request = this._coordinator.JoinNetworkRequest.create({
            token: token,
            deviceId: this.node.device.id,
            deviceName: this.node.device.name,
        });
        let msg = this._coordinator.ClientMessage.create({
            type: this._coordinator.ClientMessage.Type.JOIN_NETWORK_REQUEST,
            messageId: uuid.v4(),
            joinNetworkRequest: request,
        });
        let data = this._coordinator.ClientMessage.encode(msg).finish();
        this._logger.debug('coordinator', `Sending JOIN REQUEST to ${address}`);
        return this._coordinator.request(address, data)
            .then(response => {
                if (!response || !response.length)
                    return;

                let message;
                try {
                    message = this._coordinator.ServerMessage.decode(response);
                } catch (error) {
                    this._logger.error(`Coordinator protocol error: ${error.message}`);
                    return;
                }

                this._logger.debug('coordinator', `Response ${message.type} from ${address}`);
                if (message.type !== this._coordinator.ServerMessage.Type.JOIN_NETWORK_RESPONSE ||
                    message.messageId !== msg.messageId ||
                    message.joinNetworkResponse.response !== this._coordinator.JoinNetworkResponse.Result.ACCEPTED)
                {
                    throw new Error('Join request rejected');
                }

                return this._filer.lockUpdate(
                        '/var/lib/bhdir/.config/node.json',
                        contents => {
                            let json = JSON.parse(contents);
                            json.id = message.joinNetworkResponse.nodeId;
                            this.node = json;
                            return Promise.resolve(JSON.stringify(json, undefined, 4) + '\n');
                        }
                    )
                    .then(() => {
                        return this.syncTempFolder(
                            message.joinNetworkResponse.folderId,
                            '.core',
                            message.joinNetworkResponse.deviceId,
                            message.joinNetworkResponse.deviceName
                        );
                    })
            });
    }
    /**
     * Create node
     * @return {Promise}                            Resolves to { id, token }
     */
    createNode() {
        let now = Math.round(Date.now() / 1000);
        return this._directory.get('.core:/home/last_id')
            .then(lastId => {
                if (!lastId || !lastId.value)
                    return;

                let nodeId = (parseInt(lastId.value) + 1).toString();
                let token = this._util.getRandomString(32, { lower: true, upper: true, digits: true, special: false });
                return this._directory.set(
                        `.core:/home/nodes/by_id/${nodeId}`,
                        null,
                        {
                            created: now,
                            roles: [],
                            devices: {},
                        }
                    )
                    .then(() => {
                        return this._directory.set(
                            '.core:/home/last_id',
                            null,
                            nodeId
                        );
                    })
                    .then(() => {
                        return this._directory.set(
                            `.core:/home/nodes/by_token/${token}`,
                            null,
                            {
                                node_id: nodeId,
                                created: now,
                            }
                        );
                    })
                    .then(() => {
                        return { id: nodeId, token: token };
                    });
            });
    }

    /**
     * Check and activate node join token
     * @param {string} token                        Join token
     * @return {Promise}                            Resolves to node id or null
     */
    activateJoinToken(token) {
        if (!token || !token.length)
            return Promise.resolve(null);

        return this._directory.get(`.core:/home/nodes/by_token/${token}`)
            .then(info => {
                if (!info || !info.value)
                    return null;

                return this._directory.del(`.core:/home/nodes/by_token/${token}`)
                    .then(() => {
                        return info.value.node_id;
                    });
            });
    }

    /**
     * Add device to a node
     * @param {string|null} id                  Node ID
     * @param {string} deviceId                 Device ID
     * @param {string} deviceName               Device name
     * @return {Promise}
     */
    addNodeDevice(id, deviceId, deviceName) {
        if (!this.node || !this.node.id)
            return Promise.resolve();

        if (!id)
            id = this.node.id;

        return this._directory.get(`.core:/home/nodes/by_id/${id}`)
            .then(info => {
                if (!info || !info.value)
                    return;

                info.value.devices[deviceId] = deviceName;
                return this._directory.set(`.core:/home/nodes/by_id/${id}`, info);
            });
    }

    /**
     * Add role
     * @param {string|null} id                  Node ID
     * @param {string} role                     Name of the role
     * @return {Promise}
     */
    addRole(id, role) {
        if (!this.node || !this.node.id)
            return Promise.resolve();

        if (!id)
            id = this.node.id;

        return this._directory.get(`.core:/home/nodes/by_id/${id}`)
            .then(info => {
                if (!info || !info.value)
                    return;

                if (info.value.roles.indexOf(role) === -1)
                    info.value.roles.push(role);

                if (id === this.node.id)
                    this.roles = info.value.roles;

                return this._directory.set(`.core:/home/nodes/by_id/${id}`, info)
                    .then(() => {
                        if (id === this.node.id && role === 'coordinator')
                            return this._coordinator.startListening();
                    });
            });
    }

    /**
     * Remove role
     * @param {string|null} id                  Node ID
     * @param {string} role                     Name of the role
     * @return {Promise}
     */
    removeRole(id, role) {
        if (!this.node || !this.node.id)
            return Promise.resolve();

        if (!id)
            id = this.node.id;

        return this._directory.get(`.core:/home/nodes/by_id/${id}`)
            .then(info => {
                if (!info || !info.value)
                    return;

                info.value.roles = info.value.roles.filter(value => { return value !== role; });

                if (id === this.node.id)
                    this.roles = info.value.roles;

                return this._directory.set(`.core:/home/nodes/by_id/${id}`, info)
                    .then(() => {
                        if (id === this.node.id && role === 'coordinator')
                            return this._coordinator.stopListening();
                    });
            })
    }

    /**
     * Temporary folder synchronization
     * @param {string} folderId                 Folder ID
     * @param {string} folderName               Folder name
     * @param {string} deviceId                 Device ID
     * @param {string} deviceName               Device name
     * @return {Promise}
     */
    syncTempFolder(folderId, folderName, deviceId, deviceName) {
        if (!this.node || !this.node.id)
            return Promise.resolve();

        return this._filer.lockUpdate(
                '/var/lib/bhdir/.syncthing/config.xml',
                contents => {
                    let st = convert.xml2js(contents, { compact: true });

                    let folders = !st.configuration.folder ? [] :
                        Array.isArray(st.configuration.folder) ? st.configuration.folder : [ st.configuration.folder ];
                    let folderFound = false;
                    for (let i = 0; i < folders.length; i++) {
                        if (folders[i]._attributes.id !== folderId)
                            continue;

                        folderFound = true;
                        let devices = !folders[i].device ? [] :
                            Array.isArray(folders[i].device) ? folders[i].device : [ folders[i].device ];
                        let deviceFound = false;
                        for (let j = 0; j < devices.length; j++) {
                            if (devices[j]._attributes.id === deviceId) {
                                deviceFound = true;
                                break;
                            }
                        }
                        if (!deviceFound) {
                            devices.push({
                                _attributes: {
                                    id: deviceId,
                                    introducedBy: "",
                                }
                            });
                        }
                        folders[i].device = devices;
                    }
                    if (!folderFound) {
                        let attributes = {
                            id: folderId,
                            label: folderName,
                            path: `/var/lib/bhdir/${folderName}/`,
                            type: "readwrite",
                            rescanIntervalS: "60",
                            ignorePerms: "false",
                            autoNormalize: "true",
                        };
                        this.folders.set(folderName, attributes);
                        let folder = this._initFolder(attributes);
                        folder.device.push({
                            _attributes: {
                                id: deviceId,
                                introducedBy: "",
                            }
                        });
                        folders.push();
                    }
                    st.configuration.folder = folders;

                    let devices = !st.configuration.device ? [] :
                        Array.isArray(st.configuration.device) ? st.configuration.device : [ st.configuration.device ];
                    let deviceFound = false;
                    for (let i = 0; i < devices.length; i++) {
                        if (devices[i]._attributes.id === deviceId) {
                            deviceFound = true;
                            break;
                        }
                    }
                    if (!deviceFound)
                        devices.push(this._initDevice(deviceId, deviceName));
                    st.configuration.device = devices;

                    return Promise.resolve(convert.js2xml(st, { compact: true, spaces: 4 }) + '\n');
                }
            )
            .then(() => {
                if (!this.syncthing)
                    return;

                return this.stopMainBinary()
                    .then(() => {
                        return this.startMainBinary();
                    });
            });
    }

    /**
     * Retrieve directory server
     * @return {Coordinator}
     */
    get _directory() {
        if (this._directory_instance)
            return this._directory_instance;
        this._directory_instance = this._app.get('servers').get('directory');
        return this._directory_instance;
    }

    /**
     * Retrieve coordinator server
     * @return {Coordinator}
     */
    get _coordinator() {
        if (this._coordinator_instance)
            return this._coordinator_instance;
        this._coordinator_instance = this._app.get('servers').get('coordinator');
        return this._coordinator_instance;
    }

    /**
     * Returns default folder object for config.xml
     * @return {object}
     */
    _initFolder(attributes) {
        return {
            _attributes: attributes,
            device: [
                {
                    _attributes: {
                        id: this.node.device.id,
                        introducedBy: "",
                    }
                }
            ],
            minDiskFreePct: {
                _text: "1",
            },
            versioning: {},
            copiers: {
                _text: "0",
            },
            pullers: {
                _text: "0",
            },
            hashers: {
                _text: "0",
            },
            order: {
                _text: "random",
            },
            ignoreDelete: {
                _text: "false",
            },
            scanProgressIntervalS: {
                _text: "0",
            },
            pullerSleepS: {
                _text: "0",
            },
            pullerPauseS: {
                _text: "0",
            },
            maxConflicts: {
                _text: "-1",
            },
            disableSparseFiles: {
                _text: "false",
            },
            disableTempIndexes: {
                _text: "false",
            },
            fsync: {
                _text: "false",
            },
            paused: {
                _text: "false",
            },
            weakHashThresholdPct: {
                _text: "25",
            },
        };
    }

    /**
     * Returns default device object for config.xml
     * @return {object}
     */
    _initDevice(id, name) {
        return {
            _attributes: {
                id: id,
                name: name,
                compression: "metadata",
                introducer: "false",
                skipIntroductionRemovals: "false",
                introducedBy: "",
            },
            address: {
                _text: "dynamic",
            },
            paused: {
                _text: "false",
            },
        };
    }
}

module.exports = Syncthing;
