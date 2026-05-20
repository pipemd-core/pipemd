pub struct Config {
    pub name: String,
    pub version: String,
}

impl Config {
    pub fn new(name: &str, version: &str) -> Self {
        Config {
            name: name.to_string(),
            version: version.to_string(),
        }
    }
}