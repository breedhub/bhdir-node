/**
 * Clear Cache event
 * @module daemon/events/clear-cache
 */
const uuid = require('uuid');
const WError = require('verror').WError;

/**
 * Clear Cache event class
 */
class ClearCache {
    /**
     * Create service
     * @param {App} app                             The application
     * @param {object} config                       Configuration
     * @param {Logger} logger                       Logger service
     * @param {Redis} redis                         Redis service
     */
    constructor(app, config, logger, redis) {
        this._app = app;
        this._config = config;
        this._logger = logger;
        this._redis = redis;
    }

    /**
     * Service name is 'modules.daemon.events.clearCache'
     * @type {string}
     */
    static get provides() {
        return 'modules.daemon.events.clearCache';
    }

    /**
     * Dependencies as constructor arguments
     * @type {string[]}
     */
    static get requires() {
        return [ 'app', 'config', 'logger', 'redis' ];
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

        this._logger.debug('clear-cache', `Got CLEAR CACHE command`);
        let reply = (success, value) => {
            let reply = {
                id: message.id,
                success: success,
            };
            if (!success)
                reply.message = value;
            let data = Buffer.from(JSON.stringify(reply), 'utf8');
            this._logger.debug('touch', `Sending CLEAR CACHE response`);
            this.daemon.send(id, data);
        };

        this._redis.connect(this._config.get('cache.redis'))
            .then(client => {
                return client.query('FLUSHDB')
                    .then(() => {
                        client.done();
                    })
            })
            .then(() => {
               reply(true);
            })
            .catch(error => {
                reply(false, error.message);
                this._logger.error(new WError(error, 'ClearCache.handle()'));
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

module.exports = ClearCache;