/**
 * Restart command
 * @module commands/restart
 */
const path = require('path');
const argvParser = require('argv');

/**
 * Command class
 */
class Restart {
    /**
     * Create the service
     * @param {App} app                 The application
     * @param {object} config           Configuration
     * @param {Start} start             Start command
     * @param {Stop} stop               Stop command
     * @param {Install} install         Install command
     */
    constructor(app, config, start, stop, install) {
        this._app = app;
        this._config = config;
        this._start = start;
        this._stop = stop;
        this._install = install;
    }

    /**
     * Service name is 'commands.restart'
     * @type {string}
     */
    static get provides() {
        return 'commands.restart';
    }

    /**
     * Dependencies as constructor arguments
     * @type {string[]}
     */
    static get requires() {
        return [ 'app', 'config', 'commands.start', 'commands.stop', 'commands.install' ];
    }

    /**
     * Run the command
     * @param {string[]} argv           Arguments
     * @return {Promise}
     */
    run(argv) {
        let args = argvParser
            .option({
                name: 'help',
                short: 'h',
                type: 'boolean',
            })
            .option({
                name: 'install',
                short: 'i',
                type: 'boolean',
            })
            .run(argv);

        let onSignal = this._app.onSignal;
        this._app.onSignal = signal => {
            if (signal !== 'SIGHUP')
                onSignal(signal);
        };

        return this._stop.terminate()
            .then(() => {
                if (args.options['install'])
                    return this._install.install();
            })
            .then(() => {
                return this._start.launch();
            })
            .then(rc => {
                process.exit(rc);
            })
            .catch(error => {
                return this.error(error.message);
            })
    }

    /**
     * Log error and terminate
     * @param {...*} args
     */
    error(...args) {
        return this._app.error(...args)
            .then(
                () => {
                    process.exit(1);
                },
                () => {
                    process.exit(1);
                }
            );
    }
}

module.exports = Restart;