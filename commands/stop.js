/**
 * Stop command
 * @module commands/stop
 */
const debug = require('debug')('bhdir:command');
const path = require('path');

/**
 * Command class
 */
class Stop {
    /**
     * Create the service
     * @param {App} app                 The application
     * @param {object} config           Configuration
     * @param {Runner} runner           Runner service
     * @param {Start} start             Start command
     */
    constructor(app, config, runner, start) {
        this._app = app;
        this._config = config;
        this._runner = runner;
        this._start = start;
    }

    /**
     * Service name is 'commands.stop'
     * @type {string}
     */
    static get provides() {
        return 'commands.stop';
    }

    /**
     * Dependencies as constructor arguments
     * @type {string[]}
     */
    static get requires() {
        return [ 'app', 'config', 'runner', 'commands.start' ];
    }

    /**
     * Run the command
     * @param {object} argv             Minimist object
     * @return {Promise}
     */
    run(argv) {
        return this.terminate()
            .then(() => {
                process.exit(0);
            })
            .catch(error => {
                this.error(error.message);
            })
    }

    /**
     * Kill the daemon and wait for exit
     */
    terminate() {
        return this._runner.exec(path.join(__dirname, '..', 'bin', 'status'), [ '/var/run/bhdir/daemon.pid' ])
            .then(result => {
                if (result.code === 0)
                    return this._start.exec('kill', [ '/var/run/bhdir/daemon.pid', 'SIGTERM' ]);

                return new Promise((resolve, reject) => {
                    let tries = 0;
                    let waitExit = () => {
                        this._runner.exec(path.join(__dirname, '..', 'bin', 'status'), [ '/var/run/bhdir/daemon.pid' ])
                            .then(result => {
                                if (result.code === 100)
                                    return resolve();

                                if (result.code != 0)
                                    process.exit(1);

                                if (++tries > 10) {
                                    console.error('Daemon would not exit');
                                    process.exit(1);
                                }

                                setTimeout(() => { waitExit(); }, 500);
                            });
                    };
                    waitExit();
                });
            })
    }

    /**
     * Log error and terminate
     * @param {...*} args
     */
    error(...args) {
        console.error(...args);
        process.exit(1);
    }
}

module.exports = Stop;