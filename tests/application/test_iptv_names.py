"""A live channel's name without the provider's prefixes, quality word and note."""
import pytest

from src.application.iptv.names import CleanName, clean_channel_name


@pytest.mark.parametrize(
    "raw, expected",
    [
        ("US: TNT", "TNT"),
        ("PK | Capital Tv", "Capital Tv"),
        ("IND: TG: SAKSHI TV", "SAKSHI TV"),
        ("IND:PB: PTC Chak De", "PTC Chak De"),
        ("Af | DSTV: Moja Love*", "Moja Love"),
        ("IN | Eng: Times Now World", "Times Now World"),
        ("ININD: TG: SAKSHI TV", "SAKSHI TV"),
        ("IN-MAL | BIGG BOSS 24X7", "BIGG BOSS 24X7"),
        ("IND-Bangla: Zee Bangla", "Zee Bangla"),
        ("Npl-loc: Avenues Khabar Live", "Avenues Khabar Live"),
        ("UKR: 4 канал", "4 канал"),
        ("24/7: Basic Instinct", "Basic Instinct"),
        ("DSTV: Super Sports Golf", "Super Sports Golf"),
    ],
)
def test_a_country_or_provider_prefix_is_taken_off_at_every_level(raw, expected):
    assert clean_channel_name(raw).name == expected


@pytest.mark.parametrize(
    "raw, expected",
    [
        ("CSI: Crime Scene Investigation FHD", "CSI: Crime Scene Investigation"),
        ("NCIS: FHD", "NCIS: FHD"),
        ("FIFA: PTV SPORTS", "FIFA: PTV SPORTS"),
        ("F1TV: Data Channel (Events Only)", "F1TV: Data Channel"),
        ("MotoGP: Main Event With Coms", "MotoGP: Main Event With Coms"),
        ("NCAAF 29: No Scheduled Event.", "NCAAF 29: No Scheduled Event."),
        ("Bookies: William Hill TV 1", "Bookies: William Hill TV 1"),
        ("CRI | T20 WORLD CUP (2026)", "T20 WORLD CUP (2026)"),
    ],
)
def test_a_prefix_that_belongs_to_the_name_is_kept(raw, expected):
    assert clean_channel_name(raw).name == expected


@pytest.mark.parametrize(
    "raw, name, quality",
    [
        ("Game of Thrones FHD", "Game of Thrones", "FHD"),
        ("UK: BBC One HD", "BBC One", "HD"),
        ("Star Sports 1 HD*", "Star Sports 1", "HD"),
        ("Sports 4K", "Sports", "4K"),
        ("Film UHD", "Film", "4K"),
        ("Film 2160p", "Film", "4K"),
        ("Cartoon 1080p", "Cartoon", "FHD"),
        ("Old Channel SD", "Old Channel", "SD"),
        ("NDTV 24X7*", "NDTV 24X7", ""),
    ],
)
def test_the_quality_word_at_the_end_and_a_trailing_star_leave_the_name(raw, name, quality):
    assert clean_channel_name(raw) == CleanName(name=name, quality=quality)


def test_a_name_that_is_only_a_quality_word_keeps_it():
    assert clean_channel_name("HD") == CleanName(name="HD")
    assert clean_channel_name("FHD").quality == ""


def test_a_bracketed_note_is_kept_apart_a_bracketed_quality_is_the_quality_and_a_year_stays():
    assert clean_channel_name("IND: TG: Hindu Dharmam  ( Spiritual )") == CleanName("Hindu Dharmam", "", "Spiritual")
    assert clean_channel_name("Bhakti ( 4K )") == CleanName("Bhakti", "4K", "")
    assert clean_channel_name("Sports (Live Event) FHD") == CleanName("Sports", "FHD", "Live Event")
    assert clean_channel_name("Euro (2026)").note == ""


def test_decoration_around_a_banner_goes_and_an_empty_or_missing_name_stays():
    assert clean_channel_name("•●★--- Welcome ----★●•").name == "Welcome"
    assert clean_channel_name("") == CleanName(name="")
    assert clean_channel_name(None) == CleanName(name="")
    assert clean_channel_name("Plain Name") == CleanName(name="Plain Name")
    assert clean_channel_name("US:") == CleanName(name="US:")  # nothing left after the prefix, so the name as it was
