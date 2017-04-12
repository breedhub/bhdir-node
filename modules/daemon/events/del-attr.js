/**
 * Del Attr event
 * @module daemon/events/del-attr
 */
const uuid = require('uuid');
const WError = require('verror').WError;

/**
 * Del event class
 */
class DelAttr {
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
     * Service name is 'modules.daemon.events.delAttr'
     * @type {string}
     */
    static get provides() {
        return 'modules.daemon.events.delAttr';
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

        this._logger.debug('del', `Got DEL ATTR command`);
        let reply = (success, value) => {
            let reply = {
                id: message.id,
                success: success,
            };
            if (!success)
                reply.message = value;
            let data = Buffer.from(JSON.stringify(reply), 'utf8');
            this._logger.debug('del', `Sending DEL ATTR response`);
            this.daemon.send(id, data);
        };

        if (message.args.length !== 2)
            return reply(false, 'Invalid arguments list');

        let filename = message.args[0];
        let name = message.args[1];

        if (!this._util.isUuid(filename) && !this.directory.validatePath(filename))
            return reply(false, 'Invalid path');

        if (this.directory.constructor.protectedAttrs.indexOf(name) !== -1)
            return reply(false, 'Protected attribute');

        Promise.resolve()
            .then(() => {
                if (name === 'hdepth')
                    return this.directory.setHDepth(filename, null);
                if (name === 'fdepth')
                    return this.directory.setFDepth(filename, null);

                return this.directory.delAttr(filename, name)
            })
            .then(() => {
                reply(true);
            })
            .catch(error => {
                reply(false, error.message);
                this._logger.error(new WError(error, 'DelAttr.handle()'));
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

module.exports = DelAttr;