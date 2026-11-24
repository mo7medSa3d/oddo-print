"""Physical-output presentation metadata; transport success never proves paper output."""


def gateway_output_values(job, body, status):
    """Project authenticated status metadata for physical output only."""
    medium = body.get("outputMedium")
    current_medium = getattr(job, "output_medium", False)
    if medium != "physical":
        return {}
    if current_medium and medium != current_medium:
        raise ValueError("Gateway output medium changed for the original operation")
    return {"output_medium": "physical"}
