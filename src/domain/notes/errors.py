class NoteError(Exception):
    """Base class for note errors."""


class NoteNotFound(NoteError):
    pass


class NoteExists(NoteError):
    pass


class NoteLinked(NoteError):
    """Other notes still link to the note, so it cannot be deleted."""


class NoteConflict(NoteError):
    """The note changed (on disk, or in another tab) since the revision the caller based its edit on."""


class InvalidSlug(NoteError):
    pass


class GitError(NoteError):
    pass


class InvalidTitle(NoteError):
    pass


class InvalidTime(NoteError):
    pass


class InvalidProperty(NoteError):
    pass
