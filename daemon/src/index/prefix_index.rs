use std::collections::{HashMap, HashSet};

use super::string_table::{StringId, StringTable};

pub struct PrefixIndex {
    buckets: HashMap<u8, Vec<StringId>>,
    dirty_buckets: HashSet<u8>,
    last_seen_size: usize,
}

impl Default for PrefixIndex {
    fn default() -> Self {
        Self::new()
    }
}

impl PrefixIndex {
    pub fn new() -> Self {
        Self {
            buckets: HashMap::new(),
            dirty_buckets: HashSet::new(),
            last_seen_size: 0,
        }
    }

    pub fn lookup_prefix(
        &mut self,
        table: &StringTable,
        prefix: &str,
        limit: usize,
    ) -> Vec<StringId> {
        self.ingest_new(table);

        if prefix.is_empty() || limit == 0 {
            return Vec::new();
        }
        let Some(first) = prefix.bytes().next() else {
            return Vec::new();
        };
        let first_lower = first.to_ascii_lowercase();

        if self.dirty_buckets.contains(&first_lower) {
            if let Some(bucket) = self.buckets.get_mut(&first_lower) {
                sort_bucket(bucket, table);
            }
            self.dirty_buckets.remove(&first_lower);
        }

        let bucket = match self.buckets.get(&first_lower) {
            Some(b) => b,
            None => return Vec::new(),
        };

        let lower_prefix = prefix.to_ascii_lowercase();
        let start = binary_search_prefix(bucket, table, &lower_prefix);

        let mut results = Vec::with_capacity(limit.min(bucket.len() - start));
        for &id in &bucket[start..] {
            if results.len() >= limit {
                break;
            }
            let Some(s) = table.get(id) else {
                continue;
            };
            if !starts_with_ignore_ascii_case(s, &lower_prefix) {
                break;
            }
            results.push(id);
        }
        results
    }

    fn ingest_new(&mut self, table: &StringTable) {
        let n = table.len();
        if n == self.last_seen_size {
            return;
        }
        for i in self.last_seen_size..n {
            let id = i as StringId;
            let Some(s) = table.get(id) else {
                continue;
            };
            if s.is_empty() {
                continue;
            }
            let first = s.bytes().next().unwrap().to_ascii_lowercase();
            self.buckets.entry(first).or_default().push(id);
            self.dirty_buckets.insert(first);
        }
        self.last_seen_size = n;
    }
}

fn sort_bucket(bucket: &mut [StringId], table: &StringTable) {
    bucket.sort_by(|&a, &b| {
        let sa = table.get(a).unwrap_or("").to_ascii_lowercase();
        let sb = table.get(b).unwrap_or("").to_ascii_lowercase();
        sa.cmp(&sb)
    });
}

fn binary_search_prefix(bucket: &[StringId], table: &StringTable, lower_prefix: &str) -> usize {
    let mut lo = 0usize;
    let mut hi = bucket.len();
    while lo < hi {
        let mid = (lo + hi) / 2;
        let s = table.get(bucket[mid]).unwrap_or("").to_ascii_lowercase();
        if s.as_str() < lower_prefix {
            lo = mid + 1;
        } else {
            hi = mid;
        }
    }
    lo
}

fn starts_with_ignore_ascii_case(s: &str, lower_prefix: &str) -> bool {
    if s.len() < lower_prefix.len() {
        return false;
    }
    s.bytes()
        .zip(lower_prefix.bytes())
        .all(|(a, b)| a.to_ascii_lowercase() == b)
}
