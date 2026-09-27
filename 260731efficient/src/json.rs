//! Tiny JSON writer for the stable CLI surface.

/// Escape one string as a complete JSON string literal.
#[must_use]
pub fn string(value: &str) -> String {
    let mut output = String::with_capacity(value.len() + 2);
    output.push('"');
    for character in value.chars() {
        match character {
            '"' => output.push_str("\\\""),
            '\\' => output.push_str("\\\\"),
            '\n' => output.push_str("\\n"),
            '\r' => output.push_str("\\r"),
            '\t' => output.push_str("\\t"),
            '\u{08}' => output.push_str("\\b"),
            '\u{0c}' => output.push_str("\\f"),
            value if value <= '\u{1f}' => {
                use std::fmt::Write;
                let _ = write!(output, "\\u{:04x}", value as u32);
            }
            value => output.push(value),
        }
    }
    output.push('"');
    output
}

/// A deterministic JSON object writer.
#[derive(Default)]
pub struct Object {
    fields: Vec<(String, String)>,
}

impl Object {
    /// Empty object.
    #[must_use]
    pub const fn new() -> Self {
        Self { fields: Vec::new() }
    }

    /// Insert an already-encoded JSON value.
    pub fn raw(&mut self, key: &str, value: impl Into<String>) -> &mut Self {
        self.fields.push((key.to_owned(), value.into()));
        self
    }

    /// Insert a string.
    pub fn text(&mut self, key: &str, value: &str) -> &mut Self {
        self.raw(key, string(value))
    }

    /// Insert an integer.
    pub fn number(&mut self, key: &str, value: impl std::fmt::Display) -> &mut Self {
        self.raw(key, value.to_string())
    }

    /// Insert a boolean.
    pub fn boolean(&mut self, key: &str, value: bool) -> &mut Self {
        self.raw(key, if value { "true" } else { "false" })
    }

    /// Insert a nullable string.
    pub fn optional_text(&mut self, key: &str, value: Option<&str>) -> &mut Self {
        match value {
            Some(value) => self.text(key, value),
            None => self.raw(key, "null"),
        }
    }

    /// Finish.
    #[must_use]
    pub fn finish(self) -> String {
        let mut output = String::from("{");
        for (index, (key, value)) in self.fields.into_iter().enumerate() {
            if index != 0 {
                output.push(',');
            }
            output.push_str(&string(&key));
            output.push(':');
            output.push_str(&value);
        }
        output.push('}');
        output
    }
}

/// Encode a JSON array of strings.
#[must_use]
pub fn string_array<'a>(values: impl IntoIterator<Item = &'a str>) -> String {
    let mut output = String::from("[");
    for (index, value) in values.into_iter().enumerate() {
        if index != 0 {
            output.push(',');
        }
        output.push_str(&string(value));
    }
    output.push(']');
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escapes_control_characters() {
        assert_eq!(string("a\n\"\\\u{1}"), "\"a\\n\\\"\\\\\\u0001\"");
    }

    #[test]
    fn object_is_valid_shape() {
        let mut object = Object::new();
        object
            .text("status", "ok")
            .number("value", 3)
            .boolean("safe", true);
        assert_eq!(
            object.finish(),
            "{\"status\":\"ok\",\"value\":3,\"safe\":true}"
        );
    }
}
