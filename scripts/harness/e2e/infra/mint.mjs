import crypto from "node:crypto";
const S = process.env.GW_JWT_SECRET, b = (x) => Buffer.from(x).toString("base64url");
const t = (role) => { const h = b(JSON.stringify({ alg: "HS256", typ: "JWT" })), p = b(JSON.stringify({ role, iss: "local-harness", iat: 1760000000, exp: 2000000000 })); return `${h}.${p}.${crypto.createHmac("sha256", S).update(`${h}.${p}`).digest("base64url")}`; };
console.log(`ANON=${t("anon")}\nSERVICE=${t("service_role")}`);
