if (typeof process !== "undefined" && process.versions?.node) {
	import("undici").then((m) => {
		const { EnvHttpProxyAgent, setGlobalDispatcher } = m;
		setGlobalDispatcher(new EnvHttpProxyAgent());
	});
}

export {};
