FROM python:3.12-slim-bookworm@sha256:34386ef0cb081344d7ec1c103ba398e6e9f64e9ab3a1509accc92a4e24a07258
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
COPY deploy/webhook/receiver.py /app/webhook.py
USER 65532:65532
EXPOSE 18791
ENTRYPOINT ["python3", "/app/webhook.py", "--container"]
