# Contributing to Konto

## Development Environment Setup

### Testing with Podman and Testcontainers
If you are using Podman instead of Docker for local development, you need to expose the Podman user socket and disable Ryuk so Testcontainers can start successfully. 

You can set these environment variables in your shell or add them to a `.env.test` file:

```bash
export DOCKER_HOST="unix:///run/user/1000/podman/podman.sock"
export TESTCONTAINERS_RYUK_DISABLED="true"
```
