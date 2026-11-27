"""Read private billing snapshots published by the standalone collectors."""
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, HTTPException, Query, Response

from src.infrastructure.limark.aws_report import AWSReport
from src.infrastructure.limark.openai_report import OpenAIReport


def usage_routes(directory: Path) -> APIRouter:
    router = APIRouter(tags=["limark"])
    openai = OpenAIReport(os.environ.get("LIMARK_OPENAI_REPORT") or directory / "openai.json")
    aws_legacy = os.environ.get("LIMARK_AWS_REPORT") or directory / "aws.json"
    aws = AWSReport(os.environ.get("LIMARK_AWS_DASHBOARD_REPORT") or directory / "aws-dashboard.json",
                    fallback_path=aws_legacy)

    @router.get("/openai")
    def openai_usage(response: Response, month: str | None = Query(None, max_length=7),
                     project: str | None = Query(None, max_length=200),
                     view: Literal["full", "dashboard"] = "dashboard"):
        response.headers["Cache-Control"] = "no-store"
        try:
            return openai.view(month or current_month(), project, dashboard=view == "dashboard")
        except ValueError as error:
            raise HTTPException(422, str(error)) from None

    @router.get("/aws")
    def aws_usage(response: Response, month: str | None = Query(None, max_length=7),
                  service: str | None = Query(None, max_length=300),
                  view: Literal["dashboard"] = "dashboard"):
        response.headers["Cache-Control"] = "no-store"
        try:
            return aws.view(month or current_month(), service, dashboard=view == "dashboard")
        except ValueError as error:
            raise HTTPException(422, str(error)) from None

    return router


def current_month() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m")
