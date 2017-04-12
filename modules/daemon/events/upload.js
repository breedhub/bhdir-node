/**
 * Upload event
 * @module daemon/events/upload
 */
const uuid = require('uuid');
const WError = require('verror').WError;

/**
 * Upload event class
 */
class Upload {
    /**
     * Create service
     * @param {App} app                             The application
     * @param {object} config                       Configuration
     * @param {Logger} logger                       Logger service
     * @param {Util} util                           Util service
     */
    constructor(app, config, logger, util) {
        this._app = app;
        this._config = config;
        this._logger = logger;
        this._util = util;
    }

    /**
     * Service name is 'modules.daemon.events.upload'
     * @type {string}
     */
    static get provides() {
        return 'modules.daemon.events.upload';
    }

    /**
     * Dependencies as constructor arguments
     * @type {string[]}
     */
    static get requires() {
        return [ 'app', 'config', 'logger', 'util' ];
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

        this._logger.debug('get', `Got UPLOAD command`);
        let reply = (success, value) => {
            let reply = {
                id: message.id,
                success: success,
            };
            if (success) {
                reply.results = [
                    value,
                ];
            } else {
                reply.message = value;
            }
            let data = Buffer.from(JSON.stringify(reply), 'utf8');
            this._logger.debug('get', `Sending UPLOAD response`);
            this.daemon.send(id, data);
        };

        if (message.args.length !== 2 && message.args.length !== 3)
            return reply(false, 'Invalid arguments list');

        let name = message.args[0];
        let contents = message.args[1];
        let saveName = message.args.length === 3 ? message.args[2] : null;

        if (!this._util.isUuid(name) && !this.directory.validatePath(name))
            return reply(false, 'Invalid path');

        this.directory.uploadFile(name, Buffer.from(contents, 'base64'), saveName)
            .then(id => {
                reply(true, id);
            })
            .catch(error => {
                reply(false, error.message);
                this._logger.error(new WError(error, 'Upload.handle()'));
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

module.exports = Upload;