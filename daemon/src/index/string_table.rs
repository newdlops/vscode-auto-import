use std::collections::HashMap;

pub type StringId = u32;

#[derive(Default)]
pub struct StringTable {
    ids: HashMap<String, StringId>,
    strings: Vec<String>,
}

impl StringTable {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn from_strings(strings: Vec<String>) -> Self {
        let mut ids = HashMap::with_capacity(strings.len());
        for (i, s) in strings.iter().enumerate() {
            ids.insert(s.clone(), i as StringId);
        }
        Self { ids, strings }
    }

    pub fn all(&self) -> &[String] {
        &self.strings
    }

    pub fn intern(&mut self, s: &str) -> StringId {
        if let Some(&id) = self.ids.get(s) {
            return id;
        }
        let id = self.strings.len() as StringId;
        self.strings.push(s.to_string());
        self.ids.insert(s.to_string(), id);
        id
    }

    pub fn lookup(&self, s: &str) -> Option<StringId> {
        self.ids.get(s).copied()
    }

    pub fn get(&self, id: StringId) -> Option<&str> {
        self.strings.get(id as usize).map(|s| s.as_str())
    }

    pub fn len(&self) -> usize {
        self.strings.len()
    }

}
