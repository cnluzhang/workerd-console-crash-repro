using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [
    (name = "main", worker = (
      modules = [(name = "worker.mjs", esModule = embed "worker.mjs")],
      compatibilityDate = "2026-04-24",
    )),
    # An unrelated, statically configured worker in the same process.
    (name = "bystander", worker = (
      modules = [(name = "bystander.mjs", esModule = embed "bystander.mjs")],
      compatibilityDate = "2026-04-24",
    )),
  ],
  sockets = [
    (name = "http", address = "127.0.0.1:8080", http = (), service = "main"),
    (name = "bystander", address = "127.0.0.1:8081", http = (), service = "bystander"),
  ],
);
