"""
Fine-tune the cross-encoder on our own labelled pairs. Train split only —
held-out queries never touch training and decide adoption on the VPS.
"""
import json, random
from sentence_transformers import CrossEncoder, InputExample
from torch.utils.data import DataLoader

random.seed(7)
train = []
for line in open("rerank_pairs.jsonl"):
    r = json.loads(line)
    if r["split"] == "train":
        train.append(InputExample(texts=[r["query"], r["text"]], label=float(r["label"])))
random.shuffle(train)
print(f"train pairs: {len(train)}")
m = CrossEncoder("cross-encoder/ms-marco-MiniLM-L-6-v2", num_labels=1, max_length=256)
dl = DataLoader(train, shuffle=True, batch_size=16)
m.fit(train_dataloader=dl, epochs=2, warmup_steps=int(len(dl) * 0.1),
      optimizer_params={"lr": 2e-5}, show_progress_bar=False)
m.save("models/rerank-ft-v1")
print("saved models/rerank-ft-v1")
