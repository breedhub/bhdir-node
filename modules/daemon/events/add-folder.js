/**
 * Add Folder event
 * @module daemon/events/add-folder
 */
const uuid = require('uuid');
const WError = require('verror').WError;

/**
 * Add Folder event class
 */
class AddFolder {
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
     * Service name is 'modules.daemon.events.addFolder'
     * @type {string}
     */
    static get provides() {
        return 'modules.daemon.events.addFolder';
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

        this._logger.debug('add-folder', `Got ADD FOLDER command`);
        let reply = (success, value) => {
            let reply = {
                id: message.id,
                success: success,
            };
            if (!success)
                reply.message = value;
            let data = Buffer.from(JSON.stringify(reply), 'utf8');
            this._logger.debug('create-folder', `Sending CREATE FOLDER response`);
            this.daemon.send(id, data);
        };

        if (message.args.length !== 3)
            return reply(false, 'Invalid arguments list');

        let secret = message.args[0];
        let folder = message.args[1];
        let dir = message.args[2];

        this.directory.addFolder(folder, dir, secret)
            .then(() => {
                reply(true);
            })
            .catch(error => {
                reply(false, error.message);
                this._logger.error(new WError(error, 'AddFolder.handle()'));
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

module.exports = AddFolder;