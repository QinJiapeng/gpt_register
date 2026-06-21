import random
import string
from dataclasses import dataclass
from datetime import date

try:
    from faker import Faker
except ModuleNotFoundError:
    Faker = None


fake = Faker() if Faker else None


@dataclass
class UserData:
    full_name: str
    password: str
    age: int
    birth_date: str


def generate_password(length: int = 16) -> str:
    chars = string.ascii_letters + string.digits + "!@#$"
    return "".join(random.choice(chars) for _ in range(length)) + "A1!"


def generate_user_data() -> UserData:
    age = random.randint(25, 40)
    year = date.today().year - age
    month = random.randint(1, 12)
    day = random.randint(1, 28)
    if fake:
        full_name = fake.name()
    else:
        first = random.choice(["Alex", "Jane", "Michael", "Anna", "Lucas", "Nina", "Chris", "Mia"])
        last = random.choice(["Smith", "Taylor", "Brown", "Wilson", "Martin", "Clark", "Lee", "Walker"])
        full_name = f"{first} {last}"
    return UserData(
        full_name=full_name,
        password=generate_password(),
        age=age,
        birth_date=f"{year:04d}-{month:02d}-{day:02d}",
    )
