/**
 * Node Create event
 * @module daemon/events/node-create
 */
const fs = require('fs');
const uuid = require('uuid');
const WError = require('verror').WError;

/**
 * Node Create event class
 */
class NodeCreate {
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
     * Service name is 'modules.daemon.events.nodeCreate'
     * @type {string}
     */
    static get provides() {
        return 'modules.daemon.events.nodeCreate';
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

        this._logger.debug('node-create', `Got NODE CREATE command`);
        let reply = (success, value, token) => {
            let reply = {
                id: message.id,
                success: success,
            };
            if (success) {
                reply.results = [
                    value,
                    token
                ];
            } else {
                reply.message = value;
            }
            let data = Buffer.from(JSON.stringify(reply), 'utf8');
            this._logger.debug('node-create', `Sending NODE CREATE response`);
            this.daemon.send(id, data);
        };

        new Promise((resolve, reject) => {
                if (!this.syncthing.node)
                    return reject(new Error('bhdir is not installed'));

                try {
                    fs.accessSync('/var/lib/bhdir/.core/data/home/.vars.json', fs.constants.F_OK);
                    resolve();
                } catch (error) {
                    reject(new Error('We are not part of a network'));
                }
            })
            .then(() => {
                return this.syncthing.createNode();
            })
            .then(({ id, token }) => {
                reply(true, id, token);
            })
            .catch(error => {
                reply(false, error.message);
                this._logger.error(new WError(error, 'NodeCreate.handle()'));
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

module.exports = NodeCreate;