"""Why Colab data is missing."""


class ColabCliError(RuntimeError):
    """The `colab` CLI is missing, timed out or failed, or what it printed could not be understood."""


class ColabBusyError(ColabCliError):
    """A dashboard probe is already running, or Colab is rate limiting (HTTP 429)."""
