//! Borrow request fields and preserve provider-visible JSON object order.
use super::{Failure, Request, Result, Role, Tool, ToolCall};
use serde::ser::SerializeSeq;
use serde::{Serialize, Serializer};
use serde_json::value::RawValue;
use std::borrow::Cow;

#[derive(Serialize)]
struct Body<'a> {
    model: &'a str,
    messages: Messages<'a>,
    stream: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    stream_options: Option<Usage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tools: Option<Tools<'a>>,
}
#[derive(Serialize)]
struct Usage {
    include_usage: bool,
}
struct Messages<'a>(&'a Request);
#[derive(Serialize)]
#[serde(tag = "role", rename_all = "lowercase")]
enum ChatMessage<'a> {
    System {
        content: &'a str,
    },
    User {
        content: UserContent<'a>,
    },
    Assistant {
        content: Option<&'a str>,
        #[serde(skip_serializing_if = "Option::is_none")]
        tool_calls: Option<Calls<'a>>,
    },
    Tool {
        tool_call_id: &'a str,
        content: Cow<'a, str>,
    },
}
#[derive(Serialize)]
#[serde(untagged)]
enum UserContent<'a> {
    Text(&'a str),
    Parts(Parts<'a>),
}
struct Parts<'a> {
    images: &'a [super::Image],
    text: &'a str,
}
impl Serialize for Parts<'_> {
    fn serialize<S: Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        let mut sequence = serializer.serialize_seq(Some(self.images.len() + 1))?;
        #[derive(Serialize)]
        struct ImagePart {
            r#type: &'static str,
            image_url: ImageUrl,
        }
        #[derive(Serialize)]
        struct ImageUrl {
            url: String,
        }
        #[derive(Serialize)]
        struct TextPart<'a> {
            r#type: &'static str,
            text: &'a str,
        }
        for image in self.images {
            sequence.serialize_element(&ImagePart {
                r#type: "image_url",
                image_url: ImageUrl {
                    url: format!("data:{};base64,{}", image.mime_type, image.data),
                },
            })?;
        }
        sequence.serialize_element(&TextPart {
            r#type: "text",
            text: if self.text.is_empty() {
                "Attached image."
            } else {
                self.text
            },
        })?;
        sequence.end()
    }
}
struct Calls<'a>(&'a [ToolCall]);
#[derive(Serialize)]
struct Function<'a> {
    name: &'a str,
    arguments: &'a str,
}
#[derive(Serialize)]
struct Call<'a> {
    id: &'a str,
    r#type: &'static str,
    function: Function<'a>,
}
impl Serialize for Calls<'_> {
    fn serialize<S: Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        let mut sequence = serializer.serialize_seq(Some(self.0.len()))?;
        for call in self.0 {
            sequence.serialize_element(&Call {
                id: &call.id,
                r#type: "function",
                function: Function {
                    name: &call.name,
                    arguments: call.input.get(),
                },
            })?;
        }
        sequence.end()
    }
}
impl Serialize for Messages<'_> {
    fn serialize<S: Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        let mut sequence = serializer.serialize_seq(None)?;
        sequence.serialize_element(&ChatMessage::System {
            content: &self.0.system,
        })?;
        for message in &self.0.messages {
            match message.role {
                Role::User => {
                    let text = message.text.as_deref().unwrap_or_default();
                    let content =
                        if let Some(images) = message.images.as_ref().filter(|i| !i.is_empty()) {
                            UserContent::Parts(Parts { images, text })
                        } else {
                            UserContent::Text(text)
                        };
                    sequence.serialize_element(&ChatMessage::User { content })?;
                }
                Role::Assistant => {
                    let text = message.text.as_deref().unwrap_or_default();
                    let calls = message.tool_calls.as_deref().unwrap_or_default();
                    sequence.serialize_element(&ChatMessage::Assistant {
                        content: (!text.is_empty()).then_some(text),
                        tool_calls: (!calls.is_empty()).then_some(Calls(calls)),
                    })?;
                }
                Role::Tool => {
                    for entry in message.results.as_deref().unwrap_or_default() {
                        sequence.serialize_element(&ChatMessage::Tool {
                            tool_call_id: &entry.tool_call_id,
                            content: if entry.is_error {
                                Cow::Owned(format!("Error: {}", entry.content))
                            } else {
                                Cow::Borrowed(&entry.content)
                            },
                        })?;
                    }
                }
            }
        }
        sequence.end()
    }
}
struct Tools<'a>(&'a [Tool]);
#[derive(Serialize)]
struct ToolFunction<'a> {
    name: &'a str,
    description: &'a str,
    parameters: &'a RawValue,
}
#[derive(Serialize)]
struct ChatTool<'a> {
    r#type: &'static str,
    function: ToolFunction<'a>,
}
impl Serialize for Tools<'_> {
    fn serialize<S: Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        let mut sequence = serializer.serialize_seq(Some(self.0.len()))?;
        for tool in self.0 {
            sequence.serialize_element(&ChatTool {
                r#type: "function",
                function: ToolFunction {
                    name: &tool.name,
                    description: &tool.description,
                    parameters: &tool.parameters,
                },
            })?;
        }
        sequence.end()
    }
}
pub(super) fn body(request: &Request, usage: bool) -> Result<Vec<u8>> {
    serde_json::to_vec(&Body {
        model: &request.connection.model,
        messages: Messages(request),
        stream: true,
        stream_options: usage.then_some(Usage {
            include_usage: true,
        }),
        tools: (!request.tools.is_empty()).then_some(Tools(&request.tools)),
    })
    .map_err(|_| Failure::new("invalid_request"))
}

#[cfg(test)]
mod tests {
    #[test]
    fn schema_key_order_is_preserved_without_global_map_order_changes() {
        let input = r#"{"schema":"extalia.provider-complete.v1","requestId":"12345678-1234-4234-8234-123456789abc","clientVersion":"test","connection":{"baseUrl":"http://127.0.0.1:1","model":"test"},"system":"","messages":[],"tools":[{"name":"f","description":"","parameters":{"z":1,"a":{"y":2,"b":3}}}],"timeoutMs":100,"requestUsage":false}"#;
        let request: super::Request = serde_json::from_str(input).unwrap();
        request.prepare().unwrap();
        let body = String::from_utf8(super::body(&request, false).unwrap()).unwrap();
        assert!(body.contains(r#""parameters":{"z":1,"a":{"y":2,"b":3}}"#));
    }
}
