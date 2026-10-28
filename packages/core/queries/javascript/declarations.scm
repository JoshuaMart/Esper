; Declarations: functions, classes, methods, and function literals (arrows and expressions),
; which are named after what holds them.
(function_declaration name: (identifier) @name) @function
(generator_function_declaration name: (identifier) @name) @function
(class_declaration name: (identifier) @name) @class
(method_definition name: (_) @name) @method
(function_expression) @literal
(generator_function) @literal
(arrow_function) @literal
