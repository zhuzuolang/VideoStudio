export function connect(): never {
  throw new Error("cloudflare:sockets is only available in the Worker runtime");
}
