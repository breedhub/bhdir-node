/**
 * Daemon server
 * @module servers/daemon
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const ini = require('ini');
const net = require('net');
const uuid = require('uuid');
const EventEmitter = require('events');
const WError = require('verror').WError;
const SocketWrapper = require('socket-wrapper');

/**
 * Server class
 */
class Daemon extends EventEmitter {
    /**
     * Create the service
     * @param {App} app                     Application
     * @param {object} config               Configuration
     * @param {Logger} logger               Logger service
     * @param {Filer} filer                 Filer service
     * @param {Runner} runner               Runner service
     */
    constructor(app, config, logger, filer, runner) {
        super();

        this.server = null;
        this.clients = new Map();

        this._name = null;
        this._app = app;
        this._config = config;
        this._logger = logger;
        this._filer = filer;
        this._runner = runner;
    }

    /**
     * Service name is 'servers.daemon'
     * @type {string}
     */
    static get provides() {
        return 'servers.daemon';
    }

    /**
     * Dependencies as constructor arguments
     * @type {string[]}
     */
    static get requires() {
        return [ 'app', 'config', 'logger', 'filer', 'runner' ];
    }

    /**
     * Initialize the server
     * @param {string} name                     Config section name
     * @return {Promise}
     */
    init(name) {
        this._name = name;

        return Promise.resolve()
            .then(() => {
                this.server = net.createServer(this.onConnection.bind(this));
                this.server.on('error', this.onServerError.bind(this));
                this.server.on('listening', this.onListening.bind(this));
            });
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
                (prev, [ curName, curModule ]) => {
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
                this._logger.debug('daemon', 'Starting the server');
                let configPath = (os.platform() === 'freebsd' ? '/usr/local/etc/bhdir' : '/etc/bhdir');
                try {
                    fs.accessSync(path.join(configPath, 'bhdir.conf'), fs.constants.F_OK);
                } catch (error) {
                    throw new Error('Could not read bhdir.conf');
                }

                let bhdirConfig = ini.parse(fs.readFileSync(path.join(configPath, 'bhdir.conf'), 'utf8'));
                this._socketMode = parseInt((bhdirConfig.socket && bhdirConfig.socket.mode) || '600', 8);
                if (isNaN(this._socketMode))
                    this._socketMode = null;

                let user = (bhdirConfig.socket && bhdirConfig.socket.user) || 'root';
                let group = (bhdirConfig.socket && bhdirConfig.socket.group) || (os.platform() === 'freebsd' ? 'wheel' : 'root');

                return Promise.all([
                        this._runner.exec('grep', [ '-E', `^${user}:`, '/etc/passwd' ]),
                        this._runner.exec('grep', [ '-E', `^${group}:`, '/etc/group' ]),
                    ])
                    .then(([ userInfo, groupInfo ]) => {
                        if (user.length && parseInt(user).toString() === user) {
                            this._socketUser = parseInt(user);
                        } else {
                            let userDb = userInfo.stdout.trim().split(':');
                            if (userInfo.code !== 0 || userDb.length !== 7) {
                                this._socketUser = null;
                                this._logger.error(`Socket user ${user} not found`);
                            } else {
                                this._socketUser = parseInt(userDb[2]);
                            }
                        }

                        if (group.length && parseInt(group).toString() === group) {
                            this._socketGroup = parseInt(group);
                        } else {
                            let groupDb = groupInfo.stdout.trim().split(':');
                            if (groupInfo.code !== 0 || groupDb.length !== 4) {
                                this._socketGroup = null;
                                this._logger.error(`Socket group ${group} not found`);
                            } else {
                                this._socketGroup = parseInt(groupDb[2]);
                            }
                        }
                    });
            })
            .then(() => {
                try {
                    let sockDir = path.join('/var', 'run', this._config.project);
                    let sockFile = path.join(sockDir, this._config.instance + '.sock');
                    try {
                        fs.accessSync(sockDir, fs.constants.R_OK | fs.constants.W_OK);
                    } catch (error) {
                        this._logger.error(
                            `No access to ${sockDir}`,
                            () => { process.exit(1); }
                        );
                    }
                    try {
                        fs.accessSync(sockFile, fs.constants.F_OK);
                        fs.unlinkSync(sockFile);
                    } catch (error) {
                        // do nothing
                    }
                    this.server.listen(sockFile);
                } catch (error) {
                    throw new WError(error, 'Daemon.start()');
                }
            });
    }

    /**
     * Parse protocol command
     * @param {Buffer} data                 Raw data
     * @return {object}                     Returns parsed JSON
     */
    parse(data) {
        let json = JSON.parse(data.toString());
        if (typeof json.command !== 'string')
            throw new Error('Invalid protocol command');
        if (json.args) {
            if (!Array.isArray(json.args))
                throw new Error('Invalid protocol command arguments');
        } else {
            json.args = [];
        }

        return json;
    }

    /**
     * Send message
     * @param {string} id                   Client ID
     * @param {Buffer|null} data            Data to send
     */
    send(id, data) {
        let client = this.clients.get(id);
        if (!client || !client.socket || !client.wrapper)
            return;

        client.wrapper.send(data);
    }

    /**
     * Server error handler
     * @param {object} error            The error
     */
    onServerError(error) {
        if (error.syscall !== 'listen')
            return this._logger.error(new WError(error, 'Daemon.onServerError()'));

        switch (error.code) {
            case 'EACCES':
                this._logger.error(
                    'Could not bind to daemon socket',
                    () => { process.exit(1); }
                );
                break;
            case 'EADDRINUSE':
                this._logger.error(
                    'Daemon socket is already in use',
                    () => { process.exit(1); }
                );
                break;
            default:
                this._logger.error(
                    error,
                    () => { process.exit(1); }
                );
        }
    }

    /**
     * Server listening event handler
     */
    onListening() {
        let sock = `/var/run/${this._config.project}/${this._config.instance}.sock`;
        try {
            if (this._socketMode !== null)
                fs.chmodSync(sock, this._socketMode);
            if (this._socketUser !== null && this._socketGroup !== null)
                fs.chownSync(sock, this._socketUser, this._socketGroup);
        } catch (error) {
            this._logger.error(`Error updating socket: ${error.message}`);
        }

        this._logger.info(`Daemon is listening on ${sock}`);
    }

    /**
     * Connection handler
     * @param {object} socket           Client socket
     */
    onConnection(socket) {
        let id = uuid.v1();
        this._logger.debug('daemon', `New socket`);

        let client = {
            id: id,
            socket: socket,
            wrapper: new SocketWrapper(socket),
        };
        this.clients.set(id, client);

        client.wrapper.on(
            'receive',
            data => {
                if (!this.onMessage(id, data)) {
                    socket.end();
                    client.wrapper.detach();
                }
            }
        );

        socket.on('error', error => { this.onError(id, error); });
        socket.on('close', () => { this.onClose(id); });

        this.emit('connection', id);
    }

    /**
     * Client message handler
     * @param {string} id               Client ID
     * @param {Buffer} data             Message
     * @return {boolean}                Destroy socket on false
     */
    onMessage(id, data) {
        let client = this.clients.get(id);
        if (!client)
            return false;

        if (!data || !data.length)
            return true;

        let message;
        try {
            message = this.parse(data);
        } catch (error) {
            this._logger.error(`Daemon protocol error: ${error.message}`);
            return false;
        }

        try {
            this._logger.debug('daemon', `Client message ${message.command}`);
            switch(message.command) {
                case 'set':
                    this.emit('set', id, message);
                    break;
                case 'get':
                    this.emit('get', id, message);
                    break;
                case 'unset':
                    this.emit('unset', id, message);
                    break;
                case 'wait':
                    this.emit('wait', id, message);
                    break;
                case 'touch':
                    this.emit('touch', id, message);
                    break;
                case 'clear-cache':
                    this.emit('clear_cache', id, message);
                    break;
            }
        } catch (error) {
            this._logger.error(new WError(error, 'Daemon.onMessage()'));
        }

        return true;
    }

    /**
     * Client error handler
     * @param {string} id                   Client ID
     * @param {Error} error                 Error
     */
    onError(id, error) {
        this._logger.error(`Daemon socket error: ${error.message}`);
    }

    /**
     * Client disconnect handler
     * @param {string} id                   Client ID
     */
    onClose(id) {
        let client = this.clients.get(id);
        if (client) {
            this._logger.debug('daemon', `Client disconnected`);
            if (client.socket) {
                if (!client.socket.destroyed)
                    client.socket.destroy();
                client.socket = null;
                client.wrapper.destroy();
                client.wrapper = null;
            }
            this.clients.delete(id);
        }
    }
}

module.exports = Daemon;