class NoteError(Exception):
    """Base class for note errors."""


class NoteNotFound(NoteError):
    pass


class NoteExists(NoteError):
    pass


class InvalidSlug(NoteError):
    pass


class GitError(NoteError):
    pass


class InvalidTitle(NoteError):
    pass
