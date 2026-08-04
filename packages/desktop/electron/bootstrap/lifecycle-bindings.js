export class BootstrapLifecycleBindings {
    state;
    runnerListeners = new Set();
    constructor(state) {
        this.state = state;
    }
    getWindowManager = () => this.state.windowManager;
    setWindowManager = (windowManager) => {
        this.state.windowManager = windowManager;
    };
    getStellaAppDir = () => this.state.stellaAppDir;
    setStellaAppDir = (stellaAppDir) => {
        this.state.stellaAppDir = stellaAppDir;
    };
    getStellaDataDir = () => this.state.stellaDataDirPath;
    setStellaDataDir = (stellaDataDirPath) => {
        this.state.stellaDataDirPath = stellaDataDirPath;
    };
    getRunner = () => this.state.stellaHostRunner;
    setRunner = (runner) => {
        this.state.stellaHostRunner = runner;
        for (const listener of this.runnerListeners) {
            listener(runner);
        }
    };
    onRunnerChanged = (listener) => {
        this.runnerListeners.add(listener);
        return () => {
            this.runnerListeners.delete(listener);
        };
    };
}
