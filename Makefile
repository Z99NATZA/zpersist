.PHONY: run down

run:
	docker compose up -d --build

down:
	docker compose down
