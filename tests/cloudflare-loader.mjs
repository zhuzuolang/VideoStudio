export async function resolve(specifier, context, nextResolve) {
  if (specifier === "cloudflare:workers") {
    return {
      url: "data:text/javascript,export%20const%20env%20%3D%20%7B%7D%3B",
      shortCircuit: true,
    };
  }
  return nextResolve(specifier, context);
}
