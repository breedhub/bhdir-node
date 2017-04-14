/**
 * Syncthing server
 * @module servers/syncthing
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
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
                let ver;
                if (os.platform() === 'freebsd') {
                    ver = os.release().replace(/^([0-9]+).*$/, '$1');
                } else {
                    try {
                        let release = fs.readFileSync('/etc/debian_version', 'utf8');
                        ver = release.replace(/^([0-9]+).*$/, '$1');
                    } catch (error) {
                        return null;
                    }
                }
                return path.join(bin, os.platform() + '-' + ver + '-' + os.arch());
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
                            });
                    });
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
     * Create network
     * @param {string} name                     Name of the network
     * @return {Promise}
     */
    createNetwork(name) {
        let now = Math.round(Date.now() / 1000);
        return this._filer.lockUpdate(
                '/var/lib/bhdir/.config/node.json',
                contents => {
                    let json = JSON.parse(contents);
                    json.id = '1';
                    return Promise.resolve(JSON.stringify(json, undefined, 4) + '\n');
                }
            )
            .then(() => {
                this.node.id = '1';
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
}

module.exports = Syncthing;
