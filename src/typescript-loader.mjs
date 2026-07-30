/**
 * The published extension currently runs from TypeScript source. Node's
 * transform-types mode understands the syntax, while this narrow resolver
 * preserves the project's NodeNext `.js` import specifiers for source workers.
 */
export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    if (
      error?.code === "ERR_MODULE_NOT_FOUND"
      && specifier.startsWith(".")
      && specifier.endsWith(".js")
    ) {
      return nextResolve(`${specifier.slice(0, -3)}.ts`, context);
    }
    throw error;
  }
}
