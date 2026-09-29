export default {
  fetch() {
    try {
      // Formatting this value throws a null-prototype object, and formatLog's
      // own catch block then throws again while stringifying it.
      console.log({ get [Symbol.toStringTag]() { throw Object.create(null); } });
    } catch {
      return new Response("caught");
    }
    return new Response("survived");
  },
};
