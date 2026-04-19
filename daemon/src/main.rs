mod index;
mod ipc;
mod parsers;
mod persistence;
mod workspace;

use anyhow::Result;

#[tokio::main(flavor = "multi_thread")]
async fn main() -> Result<()> {
    ipc::run().await
}
