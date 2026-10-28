; Calls: `f(...)` and `x.f(...)`, where `x` is a package, a receiver or any other value.
(call_expression function: (identifier) @callee) @call
(call_expression
  function: (selector_expression operand: (_) @operand field: (field_identifier) @callee)) @call
