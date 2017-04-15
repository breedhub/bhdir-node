/**
 * Join Network Request event
 * @module coordinator/events/join-network-request
 */
const uuid = require('uuid');
const WError = require('verror').WError;

/**
 * Join Network Request event class
 */
class JoinNetworkRequest {
    /**
     * Create service
     * @param {App} app                             The application
     * @param {object} config                       Configuration
     * @param {Logger} logger                       Logger service
     */
    constructor(app, config, logger) {
        this._app = app;
        this._config = config;
        this._logger = logger;
    }

    /**
     * Service name is 'modules.coordinator.events.joinNetworkRequest'
     * @type {string}
     */
    static get provides() {
        return 'modules.coordinator.events.joinNetworkRequest';
    }

    /**
     * Dependencies as constructor arguments
     * @type {string[]}
     */
    static get requires() {
        return [ 'app', 'config', 'logger' ];
    }

    /**
     * Event handler
     * @param {string} id           ID of the client
     * @param {object} message      The message
     */
    handle(id, message) {
        let client = this.coordinator.clients.get(id);
        if (!client)
            return;

        this._logger.debug('join-network-request', `Got JOIN NETWORK REQUEST from ${client.socket.remoteAddress}:${client.socket.remotePort}`);
        this.syncthing.activateJoinToken(message.joinNetworkRequest.token)
            .then(nodeId => {
                if (!nodeId) {
                    let response = this.coordinator.JoinNetworkResponse.create({
                        response: this.coordinator.JoinNetworkResponse.Result.REJECTED,
                    });
                    let reply = this.coordinator.ServerMessage.create({
                        type: this.coordinator.ServerMessage.Type.JOIN_NETWORK_RESPONSE,
                        messageId: message.messageId,
                        joinNetworkResponse: response,
                    });
                    let data = this.coordinator.ServerMessage.encode(reply).finish();
                    this._logger.debug('join-network-request', `Sending JOIN NETWORK RESPONSE to ${client.socket.remoteAddress}:${client.socket.remotePort}`);
                    return this.coordinator.send(id, data);
                }

                return this.syncthing.addNodeDevice(
                        nodeId,
                        message.joinNetworkRequest.deviceId,
                        message.joinNetworkRequest.deviceName
                    )
                    .then(() => {
                        return this.syncthing.syncTempFolder(
                            this.syncthing.folders.get('.core').id,
                            '.core',
                            message.joinNetworkRequest.deviceId,
                            message.joinNetworkRequest.deviceName
                        );
                    })
                    .then(() => {
                        let response = this.coordinator.JoinNetworkResponse.create({
                            response: this.coordinator.JoinNetworkResponse.Result.ACCEPTED,
                            nodeId: nodeId,
                            deviceId: this.syncthing.node.device.id,
                            deviceName: this.syncthing.node.device.name,
                            folderId: this.syncthing.folders.get('.core').id,
                        });
                        let reply = this.coordinator.ServerMessage.create({
                            type: this.coordinator.ServerMessage.Type.JOIN_NETWORK_RESPONSE,
                            messageId: message.messageId,
                            joinNetworkResponse: response,
                        });
                        let data = this.coordinator.ServerMessage.encode(reply).finish();
                        this._logger.debug('join-network-request', `Sending JOIN NETWORK RESPONSE to ${client.socket.remoteAddress}:${client.socket.remotePort}`);
                        return this.coordinator.send(id, data);
                    });
            })
            .catch(error => {
                this._logger.error(new WError(error, 'JoinNetworkRequest.handle()'));
            });
    }

    /**
     * Retrieve coordinator server
     * @return {Coordinator}
     */
    get coordinator() {
        if (this._coordinator)
            return this._coordinator;
        this._coordinator = this._app.get('servers').get('coordinator');
        return this._coordinator;
    }

    /**
     * Retrieve directory server
     * @return {Directory}
     */
    get directory() {
        if (this._directory)
            return this._directory;
        this._directory = this._app.get('servers').get('directory');
        return this._directory;
    }

    /**
     * Retrieve syncthing server
     * @return {Syncthing}
     */
    get syncthing() {
        if (this._syncthing)
            return this._syncthing;
        this._syncthing = this._app.get('servers').get('syncthing');
        return this._syncthing;
    }
}

module.exports = ClearCache;