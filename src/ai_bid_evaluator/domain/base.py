from decimal import Decimal
from typing import Annotated
from pydantic import BaseModel, ConfigDict, Field

Identifier = Annotated[str, Field(min_length=1, max_length=100, pattern=r"^[A-Za-z0-9_-]+$")]
FiniteDecimal = Annotated[Decimal, Field(allow_inf_nan=False)]
NonNegativeDecimal = Annotated[Decimal, Field(ge=0, allow_inf_nan=False)]


class Contract(BaseModel):
    model_config = ConfigDict(extra="forbid", validate_assignment=True, validate_default=True, str_strip_whitespace=True)
