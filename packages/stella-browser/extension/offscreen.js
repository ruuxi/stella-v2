function openPort() {
  try {
    const port = chrome.runtime.connect({ name: 'keepalive' });
    port.onDisconnect.addListener(() => {

      setTimeout(openPort, 1000);
    });
  } catch {

  }
}

openPort();
