/**
 * Index event
 * @module daemon/events/index
 */
const uuid = require('uuid');
const WError = require('verror').WError;

/**
 * Index event class
 */
class Index {
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
     * Service name is 'modules.daemon.events.index'
     * @type {string}
     */
    static get provides() {
        return 'modules.daemon.events.index';
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

        this._logger.debug('index', `Got INDEX command`);
        let reply = (success, value) => {
            let reply = {
                id: message.id,
                success: success,
            };
            if (success)
                reply.results = value;
            else
                reply.message = value;
            let data = Buffer.from(JSON.stringify(reply), 'utf8');
            this._logger.debug('index', `Sending INDEX response`);
            this.daemon.send(id, data);
        };

        let folders = message.args;
        if (!folders.length)
            folders = Array.from(this.directory.directories.keys());

        folders.reduce(
                (prev, cur) => {
                    return prev.then(messages => {
                        return this.index.build(cur)
                            .then(msg => {
                                return messages.concat(msg);
                            });
                    });
                },
                Promise.resolve([])
            )
            .then(messages => {
                reply(true, messages);
            })
            .catch(error => {
                reply(false, error.message);
                this._logger.error(new WError(error, 'Index.handle()'));
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

    /**
     * Retrieve index server
     * @return {Index}
     */
    get index() {
        if (this._index)
            return this._index;
        this._index = this._app.get('servers').get('index');
        return this._index;
    }
}

module.exports = Index;