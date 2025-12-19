import dns from "node:dns";
dns.setDefaultResultOrder("ipv4first");

import { Agent, setGlobalDispatcher } from "undici";
setGlobalDispatcher(new Agent({
  connectTimeout: 20000, // 20s
  headersTimeout: 20000,
  bodyTimeout: 20000,
}));

const url = "https://canlipiyasalar.haremaltin.com/tmp/altin.json?dil_kodu=tr";

const r = await fetch(url, {
  headers: {
    "User-Agent": "Mozilla/5.0",
    "Accept": "application/json,text/plain,*/*",
    "Referer": "https://canlipiyasalar.haremaltin.com/",
  },
});
console.log(r.status);
console.log((await r.text()).slice(0, 200));
