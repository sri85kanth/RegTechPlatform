from regulatory_ingestion.agent import llm as L
r = L.complete(
  "You extract compliance obligations. Respond ONLY as a JSON object.",
  "For a hospital fire-safety regulation requiring quarterly fire drills and an evacuation plan, list obligations. Return json shaped {\"obligations\":[{\"text\":str,\"frequency\":str}]}.",
  json_mode=True, max_tokens=2500)
print("ok=", r.ok, "| model=", r.model, "| provider=", r.provider)
print("error=", r.error)
import json
print("data=", json.dumps(r.data, indent=2)[:800] if r.data else None)
print("latency_s=", r.latency_s, "| attempts=", r.attempts)
