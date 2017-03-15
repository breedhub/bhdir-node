/**
 * Get event
 * @module daemon/events/get
 */
const debug = require('debug')('bhdir:daemon');
const uuid = require('uuid');
const WError = require('verror').WError;

/**
 * Get event class
 */
class Get {
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
     * Service name is 'modules.daemon.events.get'
     * @type {string}
     */
    static get provides() {
        return 'modules.daemon.events.get';
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

        debug(`Got GET command`);
        let reply = (value) => {
            let reply = {
                id: message.id,
                results: [
                    value,
                ]
            };
            let data = Buffer.from(JSON.stringify(reply), 'utf8');
            debug(`Sending GET response`);
            this.daemon.send(id, data);
        };

        if (!message.args.length)
            return reply(null);

        this.directory.get(message.args[0])
            .then(result => {
                reply(result);
            })
            .catch(error => {
                this._logger.error(new WError(error, 'Get.handle()'));
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
}

module.exports = Get;