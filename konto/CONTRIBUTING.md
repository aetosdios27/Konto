# Contributing to Konto

## Development Environment Setup

### Testing with Podman and Testcontainers
If you are using Podman instead of Docker for local development, you need to expose the Podman user socket and disable Ryuk so Testcontainers can start successfully. 

You can set these environment variables in your shell or add them to a `.env.test` file:

```bash
export DOCKER_HOST="unix:///run/user/1000/podman/podman.sock"
export TESTCONTAINERS_RYUK_DISABLED="true"
```

### Testing with an existing PostgreSQL 16 server

Set `KONTO_TEST_DATABASE_URL` to an administrative connection URL to use an existing
server instead of starting Testcontainers. The role must be able to create and drop
databases and create roles for the permission tests. For example:

```bash
KONTO_TEST_DATABASE_URL=postgres://postgres:pw@localhost:55432/postgres pnpm -r test --run
```

Each test suite creates a randomly named `konto_test_<random>` database and drops it
on completion. No existing database tables are reused. Leave the variable unset in
CI to use PostgreSQL 16 Testcontainers with the runner's Docker installation.
