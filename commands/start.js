/**
 * Start command
 * @module commands/start
 */
const debug = require('debug')('bhdir:command');
const path = require('path');
const execFile = require('child_process').execFile;

/**
 * Command class
 */
class Start {
    /**
     * Create the service
     * @param {App} app                 The application
     * @param {object} config           Configuration
     * @param {Install} install         Install command
     */
    constructor(app, config, install) {
        this._app = app;
        this._config = config;
        this._install = install;
    }

    /**
     * Service name is 'commands.start'
     * @type {string}
     */
    static get provides() {
        return 'commands.start';
    }

    /**
     * Dependencies as constructor arguments
     * @type {string[]}
     */
    static get requires() {
        return [ 'app', 'config', 'commands.install' ];
    }

    /**
     * Run the command
     * @param {object} argv             Minimist object
     * @return {Promise}
     */
    run(argv) {
        let install = !!argv['i'];

        return Promise.resolve()
            .then(() => {
                if (install)
                    return this._install.install();
            })
            .then(() => {
                return this.launch()
            })
            .then(result => {
                if (result.code != 0) {
                    console.log(result.stdout);
                    console.error(result.stderr);
                    process.exit(1);
                }

                process.exit(0);
            })
            .catch(error => {
                this.error(error.message);
            })
    }

    /**
     * Launch the daemon
     */
    launch() {
        return this.exec('daemon')
            .then(result => {
                process.exit(result.code === 0 ? 0 : 1);
            });
    }
    /**
     * Execute command echoing output
     * @param {string} command          Path to command
     * @param {string[]} [params]       Parameters
     * @return {Promise}
     */
    exec(command, params = []) {
        return new Promise((resolve, reject) => {
            try {
                let proc = execFile(
                    path.join(__dirname, '..', 'bin', command),
                    params,
                    (error, stdout, stderr) => {
                        resolve({
                            code: error ? error.code : 0,
                            stdout: stdout,
                            stderr: stderr,
                        });
                    }
                );
                proc.stdout.pipe(process.stdout);
                proc.stderr.pipe(process.stderr);
                process.stdin.pipe(proc.stdin);
            } catch (error) {
                reject(error);
            }
        });
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

module.exports = Start;