/**
 * Coordinator server
 * @module servers/coordinator
 */
const path = require('path');
const fs = require('fs');
const net = require('net');
const uuid = require('uuid');
const protobuf = require('protobufjs');
const EventEmitter = require('events');
const WError = require('verror').WError;
const SocketWrapper = require('socket-wrapper');

/**
 * Server class
 */
class Coordinator extends EventEmitter {
    /**
     * Create the service
     * @param {App} app                             Application
     * @param {object} config                       Configuration
     * @param {Logger} logger                       Logger service
     * @param {Filer} filer                         Filer service
     */
    constructor(app, config, logger, filer) {
        super();

        this.server = null;
        this.clients = new Map();

        this._name = null;
        this._app = app;
        this._config = config;
        this._logger = logger;
        this._filer = filer;
    }

    /**
     * Service name is 'servers.coordinator'
     * @type {string}
     */
    static get provides() {
        return 'servers.coordinator';
    }

    /**
     * Dependencies as constructor arguments
     * @type {string[]}
     */
    static get requires() {
        return [ 'app', 'config', 'logger', 'filer' ];
    }

    /**
     * Coordinator address
     * @type {string}
     */
    static get coordinatorAddress() {
        return '0.0.0.0';
    }

    /**
     * Coordinator port
     * @type {string}
     */
    static get coordinatorPort() {
        return '42003';
    }

    /**
     * Initialize the server
     * @param {string} name                     Config section name
     * @return {Promise}
     */
    init(name) {
        this._name = name;

        return new Promise((resolve, reject) => {
            this._logger.debug('coordinator', 'Loading protocol');
            protobuf.load(path.join(this._config.base_path, 'proto', 'coordinator.proto'), (error, root) => {
                if (error)
                    return reject(new WError(error, 'Coordinator.init()'));

                try {
                    this.proto = root;
                    this.JoinNetworkRequest = this.proto.lookup('coordinator.JoinNetworkRequest');
                    this.JoinNetworkResponse = this.proto.lookup('coordinator.JoinNetworkResponse');
                    this.ClientMessage = this.proto.lookup('coordinator.ClientMessage');
                    this.ServerMessage = this.proto.lookup('coordinator.ServerMessage');
                    resolve();
                } catch (error) {
                    reject(new WError(error, 'Coordinator.init()'));
                }
            })
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
                this._logger.debug('coordinator', 'Starting the server');
                if (this._syncthing.roles.indexOf('coordinator') === -1)
                    return;

                return this.startListening();
            });
    }

    /**
     * Start listening on the socket
     * @return {Promise}
     */
    startListening() {
        return Promise.resolve()
            .then(() => {
                if (this.server)
                    return;

                this.server = net.createServer(this.onConnection.bind(this));
                this.server.on('error', this.onServerError.bind(this));
                this.server.on('listening', this.onListening.bind(this));
                this.server.listen(this.constructor.coordinatorPort, this.constructor.coordinatorAddress);
            });
    }

    /**
     * Stop listening on the socket
     * @return {Promise}
     */
    stopListening() {
        return Promise.resolve()
            .then(() => {
                if (!this.server)
                    return;

                this._logger.info(`Coordinator is no longer listening`);

                for (let [ id, info ] of this.clients) {
                    if (info.socket)
                        info.socket.destroy();
                    if (info.wrapper)
                        info.wrapper.destroy();
                }
                this.clients = new Map();

                this.server.close();
                this.server = null;
            });
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
     * Send request and return response
     * @param {string} address
     * @param {Buffer} request
     * @return {Promise}
     */
    request(address, request) {
        return new Promise((resolve, reject) => {
            let wrapper = new SocketWrapper();
            let socket = net.connect(this.constructor.coordinatorPort, address, () => {
                this._logger.debug('coordinator', 'Connected to remote host');
                wrapper.attach(socket);
                wrapper.on('receive', data => {
                    this._logger.debug('coordinator', 'Got remote reply');
                    resolve(data);
                    socket.end();
                });
                wrapper.send(request);
            });
            socket.on('error', error => {
                reject(error);
                wrapper.destroy();
                socket.destroy();
            });
            socket.on('close', () => {
                wrapper.destroy();
                socket.destroy();
            });
        });
    }

    /**
     * Server error handler
     * @param {object} error            The error
     */
    onServerError(error) {
        if (error.syscall !== 'listen')
            return this._logger.error(new WError(error, 'Coordinator.onServerError()'));

        let msg;
        switch (error.code) {
            case 'EACCES':
                msg = 'Could not bind to coordinator socket';
                break;
            case 'EADDRINUSE':
                msg = 'Coordinator socket is already in use';
                break;
            default:
                msg = error;
        }
        this._logger.error(msg, () => { process.exit(1); });
    }

    /**
     * Server listening event handler
     */
    onListening() {
        this._logger.info(`Coordinator is listening on ${this.constructor.coordinatorAddress}:${this.constructor.coordinatorPort}`);
    }

    /**
     * Connection handler
     * @param {object} socket           Client socket
     */
    onConnection(socket) {
        let id = uuid.v4();
        this._logger.debug('coordinator', `New socket`);

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
            message = this.ClientMessage.decode(data);
        } catch (error) {
            this._logger.error(`Coordinator protocol error: ${error.message}`);
            return false;
        }

        try {
            this._logger.debug('coordinator', `Client message ${message.type} from ${client.socket.remoteAddress}:${client.socket.remotePort}`);
            switch(message.type) {
                case this.ClientMessage.Type.JOIN_NETWORK_REQUEST:
                    this.emit('join_network_request', id, message);
                    break;
            }
        } catch (error) {
            this._logger.error(new WError(error, 'Coordinator.onMessage()'));
        }

        return true;
    }

    /**
     * Client error handler
     * @param {string} id                   Client ID
     * @param {Error} error                 Error
     */
    onError(id, error) {
        this._logger.error(`Coordinator socket error: ${error.message}`);
    }

    /**
     * Client disconnect handler
     * @param {string} id                   Client ID
     */
    onClose(id) {
        let client = this.clients.get(id);
        if (client) {
            this._logger.debug('coordinator', `Client disconnected`);
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

    /**
     * Retrieve syncthing server
     * @return {Syncthing}
     */
    get _syncthing() {
        if (this._syncthing_instance)
            return this._syncthing_instance;
        this._syncthing_instance = this._app.get('servers').get('syncthing');
        return this._syncthing_instance;
    }
}

module.exports = Coordinator;