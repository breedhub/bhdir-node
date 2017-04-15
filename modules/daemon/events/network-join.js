/**
 * Network Join event
 * @module daemon/events/network-join
 */
const fs = require('fs');
const uuid = require('uuid');
const WError = require('verror').WError;

/**
 * Network Join event class
 */
class NetworkJoin {
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
     * Service name is 'modules.daemon.events.networkJoin'
     * @type {string}
     */
    static get provides() {
        return 'modules.daemon.events.networkJoin';
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
        let client = this.daemon.clients.get(id);
        if (!client)
            return;

        this._logger.debug('network-join', `Got NETWORK JOIN command`);
        let reply = (success, value) => {
            let reply = {
                id: message.id,
                success: success,
            };
            if (!success)
                reply.message = value;
            let data = Buffer.from(JSON.stringify(reply), 'utf8');
            this._logger.debug('network-join', `Sending NETWORK JOIN response`);
            this.daemon.send(id, data);
        };

        if (message.args.length !== 2)
            return reply(false, 'Invalid arguments list');

        let address = message.args[0];
        let token = message.args[1];

        new Promise((resolve, reject) => {
                if (!this.syncthing.node)
                    return reject(new Error('bhdir is not installed'));

                try {
                    fs.accessSync('/var/lib/bhdir/.core/data/home/.vars.json', fs.constants.F_OK);
                    reject(new Error('We are already part of a network'));
                } catch (error) {
                    resolve();
                }
            })
            .then(() => {
                return this.syncthing.joinNetwork(address, token);
            })
            .then(() => {
                reply(true);
            })
            .catch(error => {
                reply(false, error.message);
                this._logger.error(new WError(error, 'NetworkJoin.handle()'));
            });
    }

    /**
     * Retrieve daemon server
     * @return {Daemon}
     */
    get daemon() {
        if (this._daemon)
            return this._daemon;
        this._daemon = this._app.get('servers').get('daemon');
        return this._daemon;
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

module.exports = NetworkJoin;