// A refusal or a mistake the user can act on, said in one line: a missing project, a ref that
// does not exist, a note written against a node the snapshot does not hold.
export class EsperError extends Error {}

// A refusal because what was named does not exist: a project, a snapshot, a node, a note, a file of
// a snapshot. The server answers it as a 404.
export class NotFound extends EsperError {}
