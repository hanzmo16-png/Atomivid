// Precarga del worker de prueba: marca el despacho como interceptado (modo fixture local de worker-cli) y aplica el
// workaround uv_interface_addresses del sandbox. worker-cli ya restringe fetch a loopback en modo fixture.
globalThis.__ATOMIVID_GH_DISPATCH_INTERCEPTED__ = true;
const os = require("os"); const oni = os.networkInterfaces;
os.networkInterfaces = function () { try { return oni.call(os); } catch { return { lo: [{ address: "127.0.0.1", netmask: "255.0.0.0", family: "IPv4", mac: "00:00:00:00:00:00", internal: true, cidr: "127.0.0.1/8" }] }; } };
