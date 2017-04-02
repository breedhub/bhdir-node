/**
 * Set Attr event
 * @module daemon/events/set-attr
 */
const uuid = require('uuid');
const WError = require('verror').WError;

/**
 * Set event class
 */
class SetAttr {
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
     * Service name is 'modules.daemon.events.setAttr'
     * @type {string}
     */
    static get provides() {
        return 'modules.daemon.events.setAttr';
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

        this._logger.debug('set', `Got SET ATTR command`);
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
            this._logger.debug('set', `Sending SET ATTR response`);
            this.daemon.send(id, data);
        };

        if (message.args.length !== 3)
            return reply(false, 'Invalid arguments list');

        let filename = message.args[0];
        let name = message.args[1];
        let value = message.args[2];

        if (!this._util.isUuid(filename) && !this.directory.validatePath(filename))
            return reply(false, 'Invalid path');

        if (this.directory.constructor.protectedAttrs.indexOf(name) !== -1)
            return reply(false, 'Protected attribute');

        let depth;
        if ([ 'hdepth', 'fdepth' ].indexOf(name) !== -1) {
            depth = parseInt(value);
            if (!isFinite(depth))
                return reply(false, 'Invalid depth');
        }

        Promise.resolve()
            .then(() => {
                if (name === 'hdepth')
                    return this.directory.setHDepth(filename, depth);
                if (name === 'fdepth')
                    return this.directory.setFDepth(filename, depth);

                return this.directory.setAttr(filename, name, value)
            })
            .then(id => {
                reply(true, id);
            })
            .catch(error => {
                reply(false, error.message);
                this._logger.error(new WError(error, 'SetAttr.handle()'));
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

module.exports = SetAttr;