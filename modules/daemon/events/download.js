/**
 * Download event
 * @module daemon/events/download
 */
const uuid = require('uuid');
const WError = require('verror').WError;

/**
 * Download event class
 */
class Download {
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
     * Service name is 'modules.daemon.events.download'
     * @type {string}
     */
    static get provides() {
        return 'modules.daemon.events.download';
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

        this._logger.debug('get', `Got DOWNLOAD command`);
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
            this._logger.debug('get', `Sending DOWNLOAD response`);
            this.daemon.send(id, data);
        };

        if (message.args.length !== 1)
            return reply(false, 'Invalid arguments list');

        let name = message.args[0];

        if (!this._util.isUuid(name) && !this.directory.validatePath(name))
            return reply(false, 'Invalid path');

        this.directory.downloadFile(name)
            .then(result => {
                if (!result)
                    return reply(false, 'File not found');

                reply(true, result.toString('base64'));
            })
            .catch(error => {
                reply(false, error.message);
                this._logger.error(new WError(error, 'Download.handle()'));
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
     * Retrieve watcher server
     * @return {Watcher}
     */
    get watcher() {
        if (this._watcher)
            return this._watcher;
        this._watcher = this._app.get('servers').get('watcher');
        return this._watcher;
    }
}

module.exports = Download;